// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test, console } from "forge-std/Test.sol";
import { IcebergRouter } from "../../contracts/iceberg/IcebergRouter.sol";

/// @notice The router must stay deployable on mainnet: EIP-170 caps runtime code at 24,576 bytes
contract RouterSizeTest is Test {
    function test_routerFitsEip170() public {
        IcebergRouter r = new IcebergRouter(address(0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a), address(0x4200000000000000000000000000000000000006), address(this), "Iceberg", "1");
        uint256 size = address(r).code.length;
        console.log("IcebergRouter runtime bytes:", size);
        assertLe(size, 24_576, "IcebergRouter exceeds EIP-170 and would fail to deploy on mainnet");
    }
}
