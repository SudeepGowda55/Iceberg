// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test, console } from "forge-std/Test.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { IcebergMath } from "../../contracts/iceberg/IcebergMath.sol";

/// @dev External wrapper so library functions can be called (and fuzzed) from tests
contract MathHarness {
    function split(uint256 t, uint256 l) external pure returns (uint256, uint256) { return IcebergMath.split(t, l); }
    function lambdaStar(uint256 g) external pure returns (uint256) { return IcebergMath.lambdaStar(g); }
    function v2Of(uint256 g) external pure returns (uint256) { return IcebergMath.v2Of(g); }
    function theorem1(uint256 g, int256 m, int256 gap, uint256 lmin) external pure returns (uint256) { return IcebergMath.lambdaTheorem1(g, m, gap, lmin); }
    function lnWad(uint256 r) external pure returns (int256) { return IcebergMath.lnWad(r); }
    function gap(uint256 p, uint256 r) external pure returns (int256) { return IcebergMath.gap(p, r); }
    function priceWad(uint256 a, uint8 da, uint256 b, uint8 db) external pure returns (uint256) { return IcebergMath.priceWad(a, da, b, db); }
    function priceFromSqrtX96(uint160 s, uint8 d0, uint8 d1) external pure returns (uint256) { return IcebergMath.priceFromSqrtX96(s, d0, d1); }
    function xycOut(uint256 i, uint256 o, uint256 a, uint256 f) external pure returns (uint256) { return IcebergMath.xycOut(i, o, a, f); }
}

/// @title IcebergMath against the paper's formulas (research/vectors.json, float64 reference) plus property fuzzing
contract IcebergMathTest is Test {
    using stdJson for string;

    MathHarness h;
    string vec;
    uint256 constant WAD = 1e18;
    // Published error bounds (absolute, wad): λ*: 1e-12, Theorem 1: 1e-9, ln: 1e-10
    uint256 constant TOL_LAMBDA_STAR = 1e6;
    uint256 constant TOL_THEOREM1 = 1e9;
    uint256 constant TOL_LN = 1e8;

    function setUp() public {
        h = new MathHarness();
        vec = vm.readFile("research/vectors.json");
    }

    function _u(string memory k) internal view returns (uint256) { return vm.parseUint(vec.readString(k)); }
    function _i(string memory k) internal view returns (int256) { return vm.parseInt(vec.readString(k)); }

    // ---------------------------------------------------------------- reference vectors

    function test_lambdaStar_matchesPaperClosedForm() public view {
        uint256 maxErr;
        for (uint256 i; i < 10; i++) {
            string memory p = string.concat(".lambdaStar[", vm.toString(i), "]");
            uint256 got = h.lambdaStar(_u(string.concat(p, ".gamma")));
            uint256 exp = _u(string.concat(p, ".expect"));
            uint256 e = got > exp ? got - exp : exp - got; if (e > maxErr) maxErr = e;
            assertLe(e, TOL_LAMBDA_STAR, "lambdaStar off the paper's closed form");
        }
        console.log("lambdaStar max abs error (wad):", maxErr);
    }

    function test_theorem1_matchesPaper() public view {
        uint256 maxErr;
        for (uint256 i; i < 40; i++) {
            string memory p = string.concat(".theorem1[", vm.toString(i), "]");
            uint256 got = h.theorem1(_u(string.concat(p, ".gamma")), _i(string.concat(p, ".m")), _i(string.concat(p, ".gap")), _u(string.concat(p, ".lmin")));
            uint256 exp = _u(string.concat(p, ".expect"));
            uint256 e = got > exp ? got - exp : exp - got; if (e > maxErr) maxErr = e;
            assertLe(e, TOL_THEOREM1, "Theorem 1 policy off the paper");
        }
        console.log("Theorem 1 max abs error (wad):", maxErr);
    }

    function test_ln_matchesReference() public view {
        uint256 maxErr;
        for (uint256 i; i < 40; i++) {
            string memory p = string.concat(".ln[", vm.toString(i), "]");
            int256 got = h.lnWad(_u(string.concat(p, ".r")));
            int256 exp = _i(string.concat(p, ".expect"));
            uint256 e = uint256(got > exp ? got - exp : exp - got); if (e > maxErr) maxErr = e;
            assertLe(e, TOL_LN, "ln off reference");
        }
        console.log("ln max abs error (wad):", maxErr);
    }

    // ---------------------------------------------------------------- paper identities

    function test_v2_satisfiesPaperFixedPoint() public view {
        uint256[5] memory gs = [uint256(0.1e18), 0.5e18, 2e18, 8e18, 30e18];
        for (uint256 i; i < 5; i++) {
            uint256 g = gs[i];
            uint256 v = h.v2Of(g);
            // v2 = γ - γ²/(4(1+v2))
            uint256 rhs = g - (g * g / WAD) * WAD / (4 * (WAD + v));
            assertApproxEqAbs(v, rhs, 1e6, "v2 closed form does not satisfy the paper's fixed point");
        }
    }

    function testFuzz_theorem1_zeroDrift_isLambdaStar(uint256 gamma, int256 gapWad) public view {
        gamma = bound(gamma, 0, 100e18);
        gapWad = bound(gapWad, -0.5e18, 0.5e18);
        assertEq(h.theorem1(gamma, 0, gapWad, 0), h.lambdaStar(gamma), "with no drift the state-dependent policy must equal lambda*");
    }

    function testFuzz_theorem1_alwaysWithinClip(uint256 gamma, int256 m, int256 gapWad, uint256 lmin) public view {
        gamma = bound(gamma, 0, 100e18);
        m = bound(m, -1e15, 1e15);
        gapWad = bound(gapWad, -0.69e18, 0.69e18);
        lmin = bound(lmin, 0, 1e18);
        uint256 l = h.theorem1(gamma, m, gapWad, lmin);
        assertGe(l, lmin); assertLe(l, WAD);
    }

    function testFuzz_lambdaStar_inUnitInterval(uint256 gamma) public view {
        gamma = bound(gamma, 0, 1e24);
        uint256 l = h.lambdaStar(gamma);
        assertGt(l, 0); assertLe(l, WAD);
    }

    // ---------------------------------------------------------------- Algorithm 1 split

    function testFuzz_split_conservesAndFavoursMaker(uint256 total, uint256 lambdaWad) public view {
        total = bound(total, 0, type(uint128).max);
        (uint256 a, uint256 p) = h.split(total, lambdaWad);
        assertEq(a + p, total, "split must conserve the reserve");
        uint256 l = lambdaWad > WAD ? WAD : lambdaWad;
        assertLe(a * WAD, total * l, "active share must round down (maker-favouring)");
        if (l == WAD) assertEq(p, 0);
        if (l == 0) assertEq(a, 0);
    }

    // ---------------------------------------------------------------- decimals and prices

    function test_priceFromSqrtX96_knownEthUsdc() public view {
        // sqrtPriceX96 for exactly 2700 USDC per ETH, currency0 = ETH (18 decimals), currency1 = USDC (6 decimals)
        uint256 p = h.priceFromSqrtX96(4116816085950893928074568, 18, 6);
        assertApproxEqRel(p, 2700e18, 1e9, "v4 price scaling wrong (decimals slip?)");
    }

    function test_priceWad_normalisesDecimals() public view {
        assertEq(h.priceWad(1e18, 18, 2700e6, 6), 2700e18, "1 WETH vs 2700 USDC must price at 2700");
        assertEq(h.priceWad(2700e6, 6, 1e18, 18), uint256(1e18) / 2700, "inverse orientation");
    }

    function test_gap_signAndClip() public view {
        assertEq(h.gap(2700e18, 2700e18), 0);
        assertGt(h.gap(2700e18, 2727e18), 0, "reference above pool => positive gap");
        assertLt(h.gap(2700e18, 2673e18), 0, "reference below pool => negative gap");
        assertApproxEqAbs(h.gap(2700e18, 2727e18), 9950330853168082, 1e10, "ln(1.01)");
        assertEq(h.gap(1e18, 5e18), 693147180559945309, "clipped at +ln2");
        assertEq(h.gap(5e18, 1e18), -693147180559945309, "clipped at -ln2");
        assertEq(h.gap(0, 1e18), 0, "empty pool reads as no gap");
    }

    // ---------------------------------------------------------------- constant product on the active pair

    function testFuzz_xycOut_neverExceedsFairAndFavoursLp(uint256 bIn, uint256 bOut, uint256 amt, uint256 fee) public view {
        bIn = bound(bIn, 1e6, 1e30); bOut = bound(bOut, 1e6, 1e30); amt = bound(amt, 1, bIn); fee = bound(fee, 0, 100_000);
        uint256 out = h.xycOut(bIn, bOut, amt, fee);
        assertLt(out, bOut, "can never drain the active side");
        assertLe(out, amt * bOut / bIn, "never better than the marginal price");
    }
}
