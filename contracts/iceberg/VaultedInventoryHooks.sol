// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IMakerHooks } from "@1inch/swap-vm/interfaces/IMakerHooks.sol";

/// @title VaultedInventoryHooks
/// @notice Maker-side SwapVM hooks that keep the maker's Aqua inventory inside ERC-4626 yield vaults
///         (Morpho / Moonwell / Steakhouse on Base) and move only the exact fill amount at the instant of a fill:
///         - preTransferOut: withdraw `amountOut` of tokenOut from the maker's vault straight into the maker wallet,
///           one call before Aqua pulls it to the taker
///         - postTransferIn: sweep the `amountIn` the taker just paid from the maker wallet into the maker's vault
///         The maker never holds idle raw tokens; Aqua virtual balances keep quoting the full vaulted inventory.
/// @dev makerData = abi.encode(address vaultForTokenA, address vaultForTokenB) ordered by token address (tokenA < tokenB)
///      Maker must approve this contract on vault shares (for withdraw) and on the raw tokens (for deposit sweep).
contract VaultedInventoryHooks is IMakerHooks {
    using SafeERC20 for IERC20;

    error OnlyRouter(address sender);
    error VaultAssetMismatch(address vault, address expected, address actual);

    address public immutable ROUTER;

    event Unvaulted(address indexed maker, address indexed vault, address token, uint256 assets, bytes32 orderHash);
    event Vaulted(address indexed maker, address indexed vault, address token, uint256 assets, bytes32 orderHash);

    constructor(address router) { ROUTER = router; }

    modifier onlyRouter() { require(msg.sender == ROUTER, OnlyRouter(msg.sender)); _; }

    function _vaultFor(address token, address tokenA, address tokenB, bytes calldata makerData) internal pure returns (IERC4626) {
        (address vaultA, address vaultB) = abi.decode(makerData, (address, address));
        return IERC4626(token == (tokenA < tokenB ? tokenA : tokenB) ? vaultA : vaultB);
    }

    function preTransferIn(address, address, address, address, uint256, uint256, bytes32, bytes calldata, bytes calldata) external onlyRouter {}
    function postTransferOut(address, address, address, address, uint256, uint256, uint256, bytes32, bytes calldata, bytes calldata) external onlyRouter {}

    /// @inheritdoc IMakerHooks
    function preTransferOut(address maker, address, address tokenIn, address tokenOut, uint256, uint256 amountOut, bytes32 orderHash, bytes calldata makerData, bytes calldata) external onlyRouter {
        IERC4626 vault = _vaultFor(tokenOut, tokenIn, tokenOut, makerData);
        if (address(vault) == address(0) || amountOut == 0) return;
        require(vault.asset() == tokenOut, VaultAssetMismatch(address(vault), tokenOut, vault.asset()));
        // Only top up what the wallet is missing, so pre-existing wallet float is used first
        uint256 held = IERC20(tokenOut).balanceOf(maker);
        if (held >= amountOut) return;
        uint256 need = amountOut - held;
        vault.withdraw(need, maker, maker); // spends maker's share allowance granted to this hook
        emit Unvaulted(maker, address(vault), tokenOut, need, orderHash);
    }

    /// @inheritdoc IMakerHooks
    function postTransferIn(address maker, address, address tokenIn, address tokenOut, uint256 amountIn, uint256, uint256 feeIn, bytes32 orderHash, bytes calldata makerData, bytes calldata) external onlyRouter {
        _sweep(maker, tokenIn, tokenOut, amountIn - feeIn, orderHash, makerData);
    }

    /// @notice SwapVM v1.0.2 signature (1inch's official router on Base): no protocol-fee argument
    function postTransferIn(address maker, address, address tokenIn, address tokenOut, uint256 amountIn, uint256, bytes32 orderHash, bytes calldata makerData, bytes calldata) external onlyRouter {
        _sweep(maker, tokenIn, tokenOut, amountIn, orderHash, makerData);
    }

    function _sweep(address maker, address tokenIn, address tokenOut, uint256 received, bytes32 orderHash, bytes calldata makerData) internal {
        IERC4626 vault = _vaultFor(tokenIn, tokenIn, tokenOut, makerData);
        if (address(vault) == address(0) || received == 0) return;
        require(vault.asset() == tokenIn, VaultAssetMismatch(address(vault), tokenIn, vault.asset()));
        IERC20(tokenIn).safeTransferFrom(maker, address(this), received);
        IERC20(tokenIn).forceApprove(address(vault), received);
        vault.deposit(received, maker);
        emit Vaulted(maker, address(vault), tokenIn, received, orderHash);
    }
}
