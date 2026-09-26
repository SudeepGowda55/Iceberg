// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { TokenMock } from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";
import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { ISwapVM } from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import { ITakerCallbacks } from "@1inch/swap-vm/interfaces/ITakerCallbacks.sol";
import { SwapVM } from "@1inch/swap-vm/SwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/libs/TakerTraits.sol";
import { XYCSwap } from "@1inch/swap-vm/instructions/XYCSwap.sol";
import { FeeFlatIn } from "@1inch/swap-vm/instructions/FeeFlat.sol";
import { CoreInvariants } from "../../lib/swap-vm/test/solidity/invariants/CoreInvariants.t.sol";
import { IcebergRouter } from "../../contracts/iceberg/IcebergRouter.sol";
import { PAActiveReserves } from "../../contracts/iceberg/PAActiveReserves.sol";

/// @title 1inch's own SwapVM invariant suite (CoreInvariants) run against Iceberg's PA-AMM program on official Aqua
/// @notice symmetry (exact-in vs exact-out), additivity, quote == swap, monotonicity, rounding favours the maker,
///         balance sufficiency; for λ = 1, 0.5 and 0.25, with and without a flat fee
contract PAInvariantsTest is Test, CoreInvariants, ITakerCallbacks {
    Aqua aqua;
    IcebergRouter router;
    TokenMock tokenA;
    TokenMock tokenB;
    address maker = makeAddr("maker");

    function setUp() public {
        aqua = new Aqua();
        router = new IcebergRouter(address(aqua), address(0), address(this), "Iceberg", "1");
        tokenA = new TokenMock("A", "A"); tokenB = new TokenMock("B", "B");
        if (address(tokenA) > address(tokenB)) (tokenA, tokenB) = (tokenB, tokenA);
        tokenA.approve(address(aqua), type(uint256).max); tokenB.approve(address(aqua), type(uint256).max);
    }

    // ---------------------------------------------------------------- CoreInvariants plumbing

    function _executeSwap(SwapVM, ISwapVM.Order memory order, address tokenIn, address, uint256 amount, bytes memory takerData)
        internal override returns (uint256 amountIn, uint256 amountOut)
    {
        TokenMock(tokenIn).mint(address(this), amount * 10);
        (amountIn, amountOut,) = router.swap(order, amount, takerData);
    }

    function preTransferInCallback(address m, address, address tokenIn, address, uint256 amountIn, uint256, bytes32 orderHash, bytes calldata) external {
        require(msg.sender == address(router));
        aqua.push(m, address(router), orderHash, tokenIn, amountIn);
    }
    function preTransferOutCallback(address, address, address, address, uint256, uint256, bytes32, bytes calldata) external {}

    function _order(bytes memory program) internal returns (ISwapVM.Order memory o) {
        o = MakerTraitsLib.build(MakerTraitsLib.Args({
            maker: maker, tokenA: address(tokenA), tokenB: address(tokenB), shouldUnwrapWeth: false, useAquaInsteadOfSignature: true,
            usePermit2: false, allowZeroAmountIn: false, receiver: address(0),
            hasPreTransferInHook: false, hasPostTransferInHook: false, hasPreTransferOutHook: false, hasPostTransferOutHook: false,
            preTransferInTarget: address(0), preTransferInData: "", postTransferInTarget: address(0), postTransferInData: "",
            preTransferOutTarget: address(0), preTransferOutData: "", postTransferOutTarget: address(0), postTransferOutData: "",
            program: program
        }));
        tokenA.mint(maker, 2_000e18); tokenB.mint(maker, 2_000e18);
        vm.startPrank(maker);
        IERC20(address(tokenA)).approve(address(aqua), type(uint256).max); IERC20(address(tokenB)).approve(address(aqua), type(uint256).max);
        address[] memory t = new address[](2); t[0] = address(tokenA); t[1] = address(tokenB);
        uint256[] memory a = new uint256[](2); a[0] = 1_000e18; a[1] = 1_000e18;
        aqua.ship(address(router), abi.encode(o), t, a);
        vm.stopPrank();
    }

    function _td(bool exactIn) internal view returns (bytes memory) {
        return TakerTraitsLib.build(TakerTraitsLib.Args({
            taker: address(this), isExactIn: exactIn, shouldUnwrapWeth: false, hasPreTransferInCallback: true, hasPreTransferOutCallback: false,
            isStrictThresholdAmount: false, isFirstTransferFromTaker: false, useTransferFromAndAquaPush: false, isAToB: true, allowPartialFill: false,
            usePermit2: false, threshold: "", to: address(0), deadline: 0, preTransferInHookData: "", postTransferInHookData: "",
            preTransferOutHookData: "", postTransferOutHookData: "", preTransferInCallbackData: "", preTransferOutCallbackData: "",
            instructionsArgs: "", signature: ""
        }));
    }

    function _run(bytes memory program, uint256 symmetryTol) internal {
        ISwapVM.Order memory o = _order(program);
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 1e18; amounts[1] = 10e18; amounts[2] = 50e18;
        InvariantConfig memory c = createInvariantConfig(amounts, symmetryTol);
        c.exactInTakerData = _td(true);
        c.exactOutTakerData = _td(false);
        assertAllInvariantsWithConfig(router, o, address(tokenA), address(tokenB), c);
    }

    // ---------------------------------------------------------------- the suite

    function test_invariants_lambdaFull() public { _run(bytes.concat(PAActiveReserves.fixedLambda(1e18), XYCSwap.build()), 2); }
    function test_invariants_lambdaHalf() public { _run(bytes.concat(PAActiveReserves.fixedLambda(0.5e18), XYCSwap.build()), 2); }
    function test_invariants_lambdaQuarter() public { _run(bytes.concat(PAActiveReserves.fixedLambda(0.25e18), XYCSwap.build()), 2); }
    function test_invariants_lambdaHalf_withFee() public { _run(bytes.concat(PAActiveReserves.fixedLambda(0.5e18), FeeFlatIn.build(0.003e7), XYCSwap.build()), 2); }
}
