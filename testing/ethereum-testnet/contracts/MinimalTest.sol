// SPDX-License-Identifier: MIT
// Canonical: none — minimal Solidity contract used as a Docker testnet compile/deploy smoke
pragma solidity ^0.8.20;

contract MinimalTest {
    uint256 public value = 42;

    function getValue() external view returns (uint256) {
        return value;
    }
}
