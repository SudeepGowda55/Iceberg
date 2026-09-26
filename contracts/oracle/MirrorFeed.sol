// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title MirrorFeed
/// @notice LOCAL-FORK ONLY. Chainlink-compatible feed that the agent updates with the live mainnet Chainlink answer,
///         so a long-running fork keeps tracking the real market. Never used on mainnet (real Chainlink is used there).
contract MirrorFeed {
    address public immutable updater;
    int256 internal _answer;
    uint256 internal _updatedAt;
    uint80 internal _round;
    string public description;

    event Mirrored(int256 answer, uint256 sourceUpdatedAt);

    constructor(address updater_, string memory description_, int256 answer_) {
        updater = updater_; description = description_; _answer = answer_; _updatedAt = block.timestamp; _round = 1;
    }

    function decimals() external pure returns (uint8) { return 8; }

    function push(int256 answer_) external {
        require(msg.sender == updater, "only updater");
        _answer = answer_; _updatedAt = block.timestamp; _round++;
        emit Mirrored(answer_, block.timestamp);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (_round, _answer, _updatedAt, _updatedAt, _round);
    }
}
