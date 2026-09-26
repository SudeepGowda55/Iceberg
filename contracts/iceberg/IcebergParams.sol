// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { ILambdaSource } from "./ILambdaSource.sol";

/// @notice Read surface used by the PAActiveReserves instruction and the v4 hook
interface IIcebergParams {
    /// @return lambdaWad keeper-set activeness λ (wad), valid only if `set`
    /// @return driftWad keeper-estimated log-price drift per block μΔt (wad, signed), used by the Theorem 1 mode
    /// @return set whether the keeper has written a value for this position
    function get(address maker, bytes32 positionId) external view returns (uint64 lambdaWad, int64 driftWad, bool set);
}

/// @title IcebergParams
/// @notice Where the fee-aware keeper publishes λ for each Iceberg position, inside bounds the maker controls.
///         The maker picks a keeper and a [minλ, maxλ] box; the keeper can only move λ inside the box and can be
///         revoked at any time. With no keeper value the position falls back to the λ baked into its program.
///         As an Aqua λ source it also never lets the active side promise more than the maker can actually deliver:
///         λ is capped at (wallet balance + what the maker's vault will release) / strategy balance of the output token.
/// @dev positionId is the Aqua order hash for the 1inch venue and the v4 poolId for the Uniswap venue
contract IcebergParams is IIcebergParams, ILambdaSource {
    error NotKeeper(address caller);
    error LambdaOutOfBounds(uint64 lambdaWad, uint64 minWad, uint64 maxWad);
    error BadBounds(uint64 minWad, uint64 maxWad);

    struct MakerConfig { address keeper; uint64 minWad; uint64 maxWad; }
    struct Value { uint64 lambdaWad; int64 driftWad; bool set; }

    mapping(address maker => MakerConfig) public config;
    mapping(address maker => mapping(bytes32 positionId => Value)) internal _values;
    /// @notice ERC-4626 vault a maker keeps each token in (used for the deliverability cap)
    mapping(address maker => mapping(address token => address vault)) public vaultOf;
    /// @dev λ used for the cap when the keeper has not published one (matches the programs' fallback)
    uint64 public constant DEFAULT_LAMBDA = 0.5e18;

    event KeeperSet(address indexed maker, address indexed keeper, uint64 minWad, uint64 maxWad);
    event VaultSet(address indexed maker, address indexed token, address vault);
    event LambdaSet(address indexed maker, bytes32 indexed positionId, uint64 lambdaWad, int64 driftWad, address indexed by);

    /// @notice Maker chooses (or revokes with address(0)) its keeper and the box λ must stay in
    function setKeeper(address keeper, uint64 minWad, uint64 maxWad) external {
        require(minWad <= maxWad && maxWad <= 1e18, BadBounds(minWad, maxWad));
        config[msg.sender] = MakerConfig(keeper, minWad, maxWad);
        emit KeeperSet(msg.sender, keeper, minWad, maxWad);
    }

    /// @notice Maker declares which ERC-4626 vault holds `token` (address(0) = kept in the wallet)
    function setVault(address token, address vault) external {
        vaultOf[msg.sender][token] = vault;
        emit VaultSet(msg.sender, token, vault);
    }

    /// @notice Keeper (or the maker itself) publishes λ and the drift estimate for one position
    function setLambda(address maker, bytes32 positionId, uint64 lambdaWad, int64 driftWad) external {
        MakerConfig memory c = config[maker];
        require(msg.sender == maker || (c.keeper != address(0) && msg.sender == c.keeper), NotKeeper(msg.sender));
        uint64 lo = c.maxWad == 0 ? 0 : c.minWad;
        uint64 hi = c.maxWad == 0 ? 1e18 : c.maxWad;
        require(lambdaWad >= lo && lambdaWad <= hi, LambdaOutOfBounds(lambdaWad, lo, hi));
        _values[maker][positionId] = Value(lambdaWad, driftWad, true);
        emit LambdaSet(maker, positionId, lambdaWad, driftWad, msg.sender);
    }

    /// @inheritdoc ILambdaSource
    /// @dev Keeper mode: the keeper's published λ (DEFAULT_LAMBDA until one is set), capped so the active share of the
    ///      output token never exceeds what the maker's wallet and vault can deliver right now
    function lambdaOf(address maker, bytes32 orderHash, address, address tokenOut, uint256, uint256 balanceOut) external view returns (uint256, bool) {
        Value memory v = _values[maker][orderHash];
        uint256 l = v.set ? v.lambdaWad : DEFAULT_LAMBDA;
        if (balanceOut != 0 && vaultOf[maker][tokenOut] != address(0)) { // makers opt in by declaring their vaults
            uint256 cap = deliverable(maker, tokenOut) * 1e18 / balanceOut;
            if (cap < l) l = cap;
        }
        return (l, true);
    }

    /// @notice What the maker can hand out of `token` right now: wallet balance plus what its vault will release
    function deliverable(address maker, address token) public view returns (uint256 amount) {
        amount = IERC20(token).balanceOf(maker);
        address vault = vaultOf[maker][token];
        if (vault != address(0)) {
            uint256 held = IERC4626(vault).convertToAssets(IERC4626(vault).balanceOf(maker));
            // MetaMorpho's maxWithdraw walks its withdraw queue (~300k gas); if it cannot finish, count what is held
            try IERC4626(vault).maxWithdraw{ gas: 450_000 }(maker) returns (uint256 max) { amount += held < max ? held : max; }
            catch { amount += held; }
        }
    }

    /// @inheritdoc IIcebergParams
    function get(address maker, bytes32 positionId) external view returns (uint64, int64, bool) {
        Value memory v = _values[maker][positionId];
        return (v.lambdaWad, v.driftWad, v.set);
    }
}
