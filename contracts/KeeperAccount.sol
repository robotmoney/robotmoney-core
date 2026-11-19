// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-timed-flows-eng-plan.md E56 (the keeper account), E34 (keeper-only settle and step);
//            docs/technical/one-vault-rebalancer-proposal.md D36
// Experiment prototype only (contracts/test/prototype/src). Not a production contract.
pragma solidity ^0.8.24;

/// @title KeeperAccount
/// @notice The one `KEEPER_ROLE` holder (E56, D36): a team-operated smart account. Its owners add and remove bot keys
///         without the fund timelock, so a broken or leaked bot key is replaced in one transaction and the fund is
///         not left without a keeper for the length of a timelock delay. A bot key can only forward a call through
///         `execute`. The account holds no funds and no role other than `KEEPER_ROLE`, so a forwarded call can only
///         do what that role allows (`settle` on the queue, `step` on the rebalancer). A bot key cannot change the
///         owners or the bot keys, because `execute` never targets the account itself.
///
///         `owners()` and `botKeys()` are the views the verifier reads (publish-contracts verify/fund.ts), so the
///         deploy tool can compare them with the sheet.
contract KeeperAccount {
    /// @notice The caller is not an owner.
    error NotOwner();
    /// @notice The caller is neither a bot key nor an owner.
    error NotBotKey();
    /// @notice A zero address, a duplicate, or an empty owner set.
    error InvalidAccount();
    /// @notice The last owner cannot be removed: nobody could rotate a bot key after that.
    error LastOwner();
    /// @notice `execute` cannot call the account itself.
    error SelfCall();
    /// @notice The forwarded call reverted. `data` is its revert data.
    error CallFailed(bytes data);

    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    event BotKeyAdded(address indexed key);
    event BotKeyRemoved(address indexed key);
    event Executed(address indexed caller, address indexed target, bytes4 selector);

    address[] private _owners;
    address[] private _botKeys;
    mapping(address => bool) private _isOwner;
    mapping(address => bool) private _isBotKey;

    constructor(address[] memory initialOwners, address[] memory initialBotKeys) {
        if (initialOwners.length == 0) revert InvalidAccount();
        for (uint256 i; i < initialOwners.length; ++i) {
            _addOwner(initialOwners[i]);
        }
        for (uint256 i; i < initialBotKeys.length; ++i) {
            _addBotKey(initialBotKeys[i]);
        }
    }

    modifier onlyOwner() {
        if (!_isOwner[msg.sender]) revert NotOwner();
        _;
    }

    // ── reads ──

    function owners() external view returns (address[] memory) {
        return _owners;
    }

    function botKeys() external view returns (address[] memory) {
        return _botKeys;
    }

    function isOwner(address who) external view returns (bool) {
        return _isOwner[who];
    }

    function isBotKey(address who) external view returns (bool) {
        return _isBotKey[who];
    }

    // ── rotation (owners only, no timelock) ──

    function addBotKey(address key) external onlyOwner {
        _addBotKey(key);
    }

    function removeBotKey(address key) external onlyOwner {
        if (!_isBotKey[key]) revert InvalidAccount();
        _isBotKey[key] = false;
        _remove(_botKeys, key);
        emit BotKeyRemoved(key);
    }

    function addOwner(address who) external onlyOwner {
        _addOwner(who);
    }

    function removeOwner(address who) external onlyOwner {
        if (!_isOwner[who]) revert InvalidAccount();
        if (_owners.length == 1) revert LastOwner();
        _isOwner[who] = false;
        _remove(_owners, who);
        emit OwnerRemoved(who);
    }

    // ── the keeper's call ──

    /// @notice Forward `data` to `target` as the account (the `KEEPER_ROLE` holder). A bot key or an owner may call it.
    ///         No value is sent. A revert of the target is passed up inside `CallFailed`.
    function execute(address target, bytes calldata data) external returns (bytes memory ret) {
        if (!_isBotKey[msg.sender] && !_isOwner[msg.sender]) revert NotBotKey();
        if (target == address(this)) revert SelfCall();
        bool ok;
        (ok, ret) = target.call(data);
        if (!ok) revert CallFailed(ret);
        emit Executed(msg.sender, target, bytes4(data));
    }

    // ── internals ──

    function _addOwner(address who) private {
        if (who == address(0) || _isOwner[who]) revert InvalidAccount();
        _isOwner[who] = true;
        _owners.push(who);
        emit OwnerAdded(who);
    }

    function _addBotKey(address key) private {
        if (key == address(0) || _isBotKey[key]) revert InvalidAccount();
        _isBotKey[key] = true;
        _botKeys.push(key);
        emit BotKeyAdded(key);
    }

    function _remove(address[] storage list, address who) private {
        uint256 n = list.length;
        for (uint256 i; i < n; ++i) {
            if (list[i] == who) {
                list[i] = list[n - 1];
                list.pop();
                return;
            }
        }
    }
}
