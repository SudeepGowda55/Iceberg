// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/interfaces/ISwapVM.sol";
import { ITakerCallbacks } from "@1inch/swap-vm/interfaces/ITakerCallbacks.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/libs/TakerTraits.sol";
import { Deadline } from "@1inch/swap-vm/instructions/Controls.sol";
import { XYCSwap } from "@1inch/swap-vm/instructions/XYCSwap.sol";
import { IcebergRouter } from "../../contracts/iceberg/IcebergRouter.sol";
import { IcebergMath } from "../../contracts/iceberg/IcebergMath.sol";
import { IcebergParams, IIcebergParams } from "../../contracts/iceberg/IcebergParams.sol";
import { Theorem1Source } from "../../contracts/iceberg/Theorem1Source.sol";
import { PAActiveReserves } from "../../contracts/iceberg/PAActiveReserves.sol";
import { ChainlinkDeviationGuard } from "../../contracts/iceberg/ChainlinkDeviationGuard.sol";
import { VaultedInventoryHooks } from "../../contracts/iceberg/VaultedInventoryHooks.sol";
import { CappedVault } from "../utils/CappedVault.sol";

contract PATaker is ITakerCallbacks {
    IAqua immutable AQUA; address immutable ROUTER;
    constructor(IAqua a, address r) { AQUA = a; ROUTER = r; }
    function swap(ISwapVM.Order calldata o, uint256 amount, bytes calldata td) external returns (uint256, uint256, bytes32) { return ISwapVM(ROUTER).swap(o, amount, td); }
    function preTransferInCallback(address maker, address, address tokenIn, address, uint256 amountIn, uint256, bytes32 orderHash, bytes calldata) external {
        require(msg.sender == ROUTER); IERC20(tokenIn).approve(address(AQUA), amountIn); AQUA.push(maker, ROUTER, orderHash, tokenIn, amountIn);
    }
    function preTransferOutCallback(address, address, address, address, uint256, uint256, bytes32, bytes calldata) external {}
}

/// @dev Chainlink-shaped feed answering a fixed price, to prove the guard trips
contract FakeFeed {
    int256 public answer; uint256 public updatedAt;
    constructor(int256 a) { answer = a; updatedAt = block.timestamp; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) { return (1, answer, updatedAt, updatedAt, 1); }
}

/// @title PAActiveReserves on a Base mainnet fork: official Aqua, real WETH/USDC, real v4 pool, real Chainlink, real Morpho vaults
contract PAActiveReservesForkTest is Test {
    IAqua constant AQUA = IAqua(0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a);
    address constant POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant FEED_ETH_USD = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;
    bytes32 constant POOL_ID = 0x96d4b53a38337a5733179751781178a2613306063c511b78cd02684739288c0a; // native ETH/USDC 0.05%
    IERC4626 constant VAULT_WETH = IERC4626(0xa0E430870c4604CcfC7B38Ca7845B1FF653D0ff1);
    IERC4626 constant VAULT_USDC = IERC4626(0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183);
    bytes32 constant SLOT = 0xfabd6331e5dc79e94909edfa47f08fc600c5100d62072d0dc6767da2435c9700;

    IcebergRouter router; PATaker taker; IcebergParams params;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        router = new IcebergRouter(address(AQUA), WETH, address(this), "Iceberg", "1");
        taker = new PATaker(AQUA, address(router));
        params = new IcebergParams();
    }

    // ------------------------------------------------------------------ helpers

    function _order(address maker, bytes memory program, address hooks, bytes memory vaults) internal pure returns (ISwapVM.Order memory) {
        bool h = hooks != address(0);
        return MakerTraitsLib.build(MakerTraitsLib.Args({
            maker: maker, tokenA: WETH, tokenB: USDC, shouldUnwrapWeth: false, useAquaInsteadOfSignature: true, usePermit2: false,
            allowZeroAmountIn: false, receiver: address(0),
            hasPreTransferInHook: false, hasPostTransferInHook: h, hasPreTransferOutHook: h, hasPostTransferOutHook: false,
            preTransferInTarget: address(0), preTransferInData: "", postTransferInTarget: hooks, postTransferInData: vaults,
            preTransferOutTarget: hooks, preTransferOutData: vaults, postTransferOutTarget: address(0), postTransferOutData: "",
            program: program
        }));
    }

    function _ship(address maker, ISwapVM.Order memory o, uint256 weth, uint256 usdc) internal returns (bytes32 hash) {
        deal(WETH, maker, weth); deal(USDC, maker, usdc);
        vm.startPrank(maker);
        IERC20(WETH).approve(address(AQUA), type(uint256).max); IERC20(USDC).approve(address(AQUA), type(uint256).max);
        address[] memory t = new address[](2); t[0] = WETH; t[1] = USDC;
        uint256[] memory a = new uint256[](2); a[0] = weth; a[1] = usdc;
        hash = AQUA.ship(address(router), abi.encode(o), t, a);
        vm.stopPrank();
    }

    function _pa(bytes memory paInstr) internal view returns (bytes memory) {
        return bytes.concat(Deadline.build(uint40(block.timestamp + 30 days)), paInstr, XYCSwap.build());
    }

    function _td(bool exactIn, bool aToB) internal view returns (bytes memory) {
        return TakerTraitsLib.build(TakerTraitsLib.Args({
            taker: address(taker), isExactIn: exactIn, shouldUnwrapWeth: false, hasPreTransferInCallback: true, hasPreTransferOutCallback: false,
            isStrictThresholdAmount: false, isFirstTransferFromTaker: false, useTransferFromAndAquaPush: false, isAToB: aToB, allowPartialFill: false,
            usePermit2: false, threshold: "", to: address(0), deadline: 0, preTransferInHookData: "", postTransferInHookData: "",
            preTransferOutHookData: "", postTransferOutHookData: "", preTransferInCallbackData: "", preTransferOutCallbackData: "",
            instructionsArgs: "", signature: ""
        }));
    }

    /// @dev Stored split for (orderHash, token): (blockNumber, passive)
    function _split(bytes32 h, address token) internal view returns (uint256 blockNumber, uint256 passive) {
        bytes32 inner = keccak256(abi.encode(h, SLOT));
        uint256 packed = uint256(vm.load(address(router), keccak256(abi.encode(token, inner))));
        return (packed >> 192, uint192(packed));
    }

    function _aqua(address maker, bytes32 h, address token) internal view returns (uint256 b) { (b,) = AQUA.rawBalances(maker, address(router), h, token); }

    function _buyWeth(ISwapVM.Order memory o, uint256 usdcIn) internal returns (uint256 qOut, uint256 aOut) {
        deal(USDC, address(taker), usdcIn);
        (, qOut,) = router.asView().quote(o, usdcIn, _td(true, false));
        (, aOut,) = taker.swap(o, usdcIn, _td(true, false));
    }

    // ------------------------------------------------------------------ tests

    function test_lambdaOne_isExactlyThePlainCurve() public {
        address m1 = makeAddr("plain"); address m2 = makeAddr("pa1");
        ISwapVM.Order memory plain = _order(m1, bytes.concat(Deadline.build(uint40(block.timestamp + 30 days)), XYCSwap.build()), address(0), "");
        ISwapVM.Order memory pa = _order(m2, _pa(PAActiveReserves.fixedLambda(1e18)), address(0), "");
        _ship(m1, plain, 2 ether, 5_400e6); _ship(m2, pa, 2 ether, 5_400e6);
        (, uint256 outPlain) = _buyWeth(plain, 500e6);
        (, uint256 outPa) = _buyWeth(pa, 500e6);
        assertEq(outPa, outPlain, "lambda = 1 must reproduce the stock XYC curve exactly");
    }

    function test_firstFillOfBlock_quoteEqualsSwap_andStoresSplit() public {
        address m = makeAddr("half");
        ISwapVM.Order memory o = _order(m, _pa(PAActiveReserves.fixedLambda(0.5e18)), address(0), "");
        bytes32 h = _ship(m, o, 2 ether, 5_400e6);
        (uint256 q, uint256 a) = _buyWeth(o, 500e6);
        assertEq(a, q, "quote must equal swap on the first fill of a block");
        (uint256 b, uint256 pW) = _split(h, WETH);
        (, uint256 pU) = _split(h, USDC);
        assertEq(b, block.number, "split stamped with this block");
        assertEq(pW, 1 ether, "passive WETH = (1-0.5) * 2 WETH");
        assertEq(pU, 2_700e6, "passive USDC = (1-0.5) * 5400 USDC");
        // the fill used only the active half: same as a plain curve over 1 WETH / 2700 USDC
        assertEq(a, IcebergMath.xycOut(2_700e6, 1 ether, 500e6, 0), "fill priced on the active pair only");
    }

    function test_secondFillSameBlock_readsStoredSplit_passiveUntouched() public {
        address m = makeAddr("second");
        ISwapVM.Order memory o = _order(m, _pa(PAActiveReserves.fixedLambda(0.5e18)), address(0), "");
        bytes32 h = _ship(m, o, 2 ether, 5_400e6);
        _buyWeth(o, 500e6);
        (, uint256 pW1) = _split(h, WETH); (, uint256 pU1) = _split(h, USDC);
        uint256 wethTotal = _aqua(m, h, WETH); uint256 usdcTotal = _aqua(m, h, USDC);
        (uint256 q2, uint256 a2) = _buyWeth(o, 300e6);
        assertEq(a2, q2, "quote must equal swap on the second fill of the block");
        (, uint256 pW2) = _split(h, WETH); (, uint256 pU2) = _split(h, USDC);
        assertEq(pW2, pW1, "passive WETH must not change inside the block");
        assertEq(pU2, pU1, "passive USDC must not change inside the block");
        assertEq(a2, IcebergMath.xycOut(usdcTotal - pU1, wethTotal - pW1, 300e6, 0), "second fill priced on (total - stored passive)");
    }

    function test_nextBlock_resplitsFromNewTotals() public {
        address m = makeAddr("resplit");
        ISwapVM.Order memory o = _order(m, _pa(PAActiveReserves.fixedLambda(0.5e18)), address(0), "");
        bytes32 h = _ship(m, o, 2 ether, 5_400e6);
        _buyWeth(o, 500e6);
        vm.roll(block.number + 1);
        uint256 wethTotal = _aqua(m, h, WETH);
        _buyWeth(o, 100e6);
        (uint256 b, uint256 pW) = _split(h, WETH);
        assertEq(b, block.number, "new block re-stamps the split");
        assertEq(pW, wethTotal - wethTotal / 2, "passive recomputed as (1-lambda) of the new total");
    }

    function test_passiveCanNeverBeTraded() public {
        address m = makeAddr("passive");
        ISwapVM.Order memory o = _order(m, _pa(PAActiveReserves.fixedLambda(0.25e18)), address(0), "");
        bytes32 h = _ship(m, o, 2 ether, 5_400e6);
        // exact-out asking for more WETH than the active 0.5 WETH must revert
        deal(USDC, address(taker), 1_000_000e6);
        vm.expectRevert();
        taker.swap(o, 0.6 ether, _td(false, false));
        // a huge exact-in can only ever drain toward the active side's limit, the passive 1.5 WETH stays
        (, uint256 out) = _buyWeth(o, 500_000e6);
        assertLt(out, 0.5 ether, "output bounded by the active share");
        assertGe(_aqua(m, h, WETH), 1.5 ether, "passive WETH untouched");
    }

    function test_lowerLambda_lessDepthForTheSameTrade() public {
        address m1 = makeAddr("l100"); address m2 = makeAddr("l050");
        ISwapVM.Order memory full = _order(m1, _pa(PAActiveReserves.fixedLambda(1e18)), address(0), "");
        ISwapVM.Order memory half = _order(m2, _pa(PAActiveReserves.fixedLambda(0.5e18)), address(0), "");
        _ship(m1, full, 2 ether, 5_400e6); _ship(m2, half, 2 ether, 5_400e6);
        (, uint256 outFull) = _buyWeth(full, 1_000e6);
        (, uint256 outHalf) = _buyWeth(half, 1_000e6);
        assertLt(outHalf, outFull, "only half the reserves are exposed to an arbitrageur this block");
    }

    function test_keeperMode_boundsAndFallback() public {
        address m = makeAddr("kept"); address keeper = makeAddr("keeper");
        ISwapVM.Order memory o = _order(m, _pa(PAActiveReserves.sourcedLambda(address(params), 0.8e18, 0.1e18)), address(0), "");
        bytes32 h = _ship(m, o, 2 ether, 5_400e6);
        vm.prank(m); params.setKeeper(keeper, 0.2e18, 1e18);
        vm.prank(makeAddr("stranger")); vm.expectRevert(abi.encodeWithSelector(IcebergParams.NotKeeper.selector, makeAddr("stranger")));
        params.setLambda(m, h, 0.5e18, 0);
        vm.prank(keeper); vm.expectRevert(abi.encodeWithSelector(IcebergParams.LambdaOutOfBounds.selector, uint64(0.1e18), uint64(0.2e18), uint64(1e18)));
        params.setLambda(m, h, 0.1e18, 0);
        // unset -> IcebergParams answers its DEFAULT_LAMBDA (0.5); no vault declared, so no deliverability cap
        _buyWeth(o, 100e6);
        (, uint256 pW) = _split(h, WETH);
        assertEq(pW, 1 ether, "unset keeper value uses the params default lambda");
        // keeper publishes 0.3 -> next block uses it
        vm.prank(keeper); params.setLambda(m, h, 0.3e18, 0);
        vm.roll(block.number + 1);
        uint256 total = _aqua(m, h, WETH);
        _buyWeth(o, 100e6);
        (, pW) = _split(h, WETH);
        (uint256 act,) = IcebergMath.split(total, 0.3e18);
        assertEq(pW, total - act, "keeper lambda applied");
    }

    function test_deliverabilityCap_lambdaNeverPromisesMoreThanTheVaultReleases() public {
        address m = makeAddr("capped");
        CappedVault vW = new CappedVault(IERC20(WETH));
        ISwapVM.Order memory o = _order(m, _pa(PAActiveReserves.sourcedLambda(address(params), 0.9e18, 0.1e18)), address(0), "");
        // maker keeps its WETH in a vault that will only release 0.3 WETH right now (e.g. Morpho liquidity is lent out)
        deal(WETH, m, 2 ether); deal(USDC, m, 5_400e6);
        vm.startPrank(m);
        IERC20(WETH).approve(address(vW), 2 ether); vW.deposit(2 ether, m);
        params.setVault(WETH, address(vW));
        params.setLambda(m, keccak256("unused"), 0.9e18, 0);
        IERC20(WETH).approve(address(AQUA), type(uint256).max); IERC20(USDC).approve(address(AQUA), type(uint256).max);
        address[] memory t = new address[](2); t[0] = WETH; t[1] = USDC;
        uint256[] memory a = new uint256[](2); a[0] = 2 ether; a[1] = 5_400e6;
        bytes32 h = AQUA.ship(address(router), abi.encode(o), t, a);
        vm.stopPrank();
        vW.setCap(0.3 ether);
        vm.prank(m); params.setLambda(m, h, 0.9e18, 0);
        // quote a WETH buy: λ must be capped to 0.3 / 2 = 15%, so the active WETH is at most what the vault can release
        deal(USDC, address(taker), 1_000e6);
        (, uint256 qOut,) = router.asView().quote(o, 1_000e6, _td(true, false));
        assertLt(qOut, 0.3 ether, "never quotes more WETH than the vault can deliver");
        assertEq(params.deliverable(m, WETH), 0.3 ether);
        (uint256 l, bool ok) = params.lambdaOf(m, h, USDC, WETH, 5_400e6, 2 ether);
        assertTrue(ok); assertEq(l, 0.15e18, "lambda capped at deliverable / balance");
    }

    function test_keeperMode_brokenParamsFallBackInsteadOfReverting() public {
        address m = makeAddr("broken");
        // WETH has no get(): the read reverts, the instruction must fall back to the program lambda, not freeze the fill
        ISwapVM.Order memory o = _order(m, _pa(PAActiveReserves.sourcedLambda(WETH, 0.6e18, 0)), address(0), "");
        bytes32 h = _ship(m, o, 2 ether, 5_400e6);
        (uint256 q, uint256 a) = _buyWeth(o, 100e6);
        assertEq(a, q);
        (, uint256 pW) = _split(h, WETH);
        assertEq(pW, 2 ether - 2 ether * 6 / 10, "fallback lambda used");
    }

    function test_theorem1Mode_zeroDrift_splitsAtLambdaStar() public {
        address m = makeAddr("thm1");
        uint64 gamma = 2e18;
        Theorem1Source src = new Theorem1Source(IIcebergParams(address(params)), gamma, 0.1e18, POOL_MANAGER, POOL_ID, USDC);
        ISwapVM.Order memory o = _order(m, _pa(PAActiveReserves.sourcedLambda(address(src), 0.9e18, 0.1e18)), address(0), "");
        bytes32 h = _ship(m, o, 2 ether, 5_400e6);
        (uint256 q, uint256 a) = _buyWeth(o, 100e6);
        assertEq(a, q, "Theorem 1 mode: quote == swap (reads live v4 state, writes nothing on quote)");
        (, uint256 pW) = _split(h, WETH);
        (uint256 act,) = IcebergMath.split(2 ether, IcebergMath.lambdaStar(gamma));
        assertEq(pW, 2 ether - act, "with no drift the paper's policy splits at lambda*(gamma)");
    }

    function test_guard_passesOnRealChainlink_tripsOnDeviationAndStaleness() public {
        address m = makeAddr("guarded");
        bytes memory guard = ChainlinkDeviationGuard.build(FEED_ETH_USD, 3600, 100, POOL_MANAGER, POOL_ID, 18, 6);
        ISwapVM.Order memory o = _order(m, bytes.concat(guard, _pa(PAActiveReserves.fixedLambda(0.5e18))), address(0), "");
        _ship(m, o, 2 ether, 5_400e6);
        _buyWeth(o, 100e6); // real v4 spot vs real Chainlink: within 1%

        (, int256 real,,,) = FakeFeed(FEED_ETH_USD).latestRoundData();
        FakeFeed off = new FakeFeed(real * 105 / 100);
        address m2 = makeAddr("tripped");
        ISwapVM.Order memory o2 = _order(m2, bytes.concat(ChainlinkDeviationGuard.build(address(off), 3600, 100, POOL_MANAGER, POOL_ID, 18, 6), _pa(PAActiveReserves.fixedLambda(0.5e18))), address(0), "");
        _ship(m2, o2, 2 ether, 5_400e6);
        deal(USDC, address(taker), 100e6);
        vm.expectRevert();
        taker.swap(o2, 100e6, _td(true, false));

        vm.warp(block.timestamp + 2 days); // real feed now stale for a 1h bound
        deal(USDC, address(taker), 100e6);
        vm.expectRevert();
        taker.swap(o, 100e6, _td(true, false));
    }

    function test_vaultedInventory_withPartialActivity() public {
        address m = makeAddr("vaulted");
        VaultedInventoryHooks hooks = new VaultedInventoryHooks(address(router));
        bytes memory vaults = abi.encode(address(VAULT_WETH), address(VAULT_USDC)); // ordered by token address (WETH < USDC)
        ISwapVM.Order memory o = _order(m, _pa(PAActiveReserves.fixedLambda(0.5e18)), address(hooks), vaults);
        deal(WETH, m, 2 ether); deal(USDC, m, 5_400e6);
        vm.startPrank(m);
        IERC20(WETH).approve(address(VAULT_WETH), 2 ether); VAULT_WETH.deposit(2 ether, m);
        IERC20(USDC).approve(address(VAULT_USDC), 5_400e6); VAULT_USDC.deposit(5_400e6, m);
        IERC20(WETH).approve(address(AQUA), type(uint256).max); IERC20(USDC).approve(address(AQUA), type(uint256).max);
        IERC20(address(VAULT_WETH)).approve(address(hooks), type(uint256).max); IERC20(address(VAULT_USDC)).approve(address(hooks), type(uint256).max);
        IERC20(WETH).approve(address(hooks), type(uint256).max); IERC20(USDC).approve(address(hooks), type(uint256).max);
        address[] memory t = new address[](2); t[0] = WETH; t[1] = USDC;
        uint256[] memory amt = new uint256[](2); amt[0] = 2 ether; amt[1] = 5_400e6;
        AQUA.ship(address(router), abi.encode(o), t, amt);
        vm.stopPrank();
        assertEq(IERC20(WETH).balanceOf(m), 0, "maker holds no raw WETH, only vault shares");
        (uint256 q, uint256 a) = _buyWeth(o, 500e6);
        assertEq(a, q, "vaulted + partially active: quote == swap");
        assertEq(IERC20(WETH).balanceOf(address(taker)), a, "taker got WETH straight out of the Morpho vault");
        assertEq(IERC20(USDC).balanceOf(m), 0, "proceeds swept back into the USDC vault");
    }
}
