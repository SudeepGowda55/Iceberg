// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/// @dev ERC-4626 vault whose withdrawable amount can be capped, standing in for a Morpho vault whose liquidity is lent out
contract CappedVault is ERC4626 {
    uint256 public cap = type(uint256).max;
    constructor(IERC20 asset_) ERC20("Capped", "CAP") ERC4626(asset_) { }
    function setCap(uint256 c) external { cap = c; }
    function maxWithdraw(address owner) public view override returns (uint256) { uint256 m = super.maxWithdraw(owner); return m < cap ? m : cap; }
}
