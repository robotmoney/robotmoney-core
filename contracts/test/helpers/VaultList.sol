// SPDX-License-Identifier: MIT
// Canonical: none — test helper for DeployTimelock's VAULT_ADDRESSES in-process form
pragma solidity ^0.8.24;

/// @dev A one-element vault list, the in-process form of a single-entry VAULT_ADDRESSES.
function _one(address a) pure returns (address[] memory v) {
    v = new address[](1);
    v[0] = a;
}
