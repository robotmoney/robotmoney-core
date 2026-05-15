// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §2.3 — Governance Boundary
// Implements: docs/implementation-plan.md "Router-weight governance" phase
// Implements: issue #365 (RM token drip in faucet tab)
pragma solidity ^0.8.24;

/// @title RmToken — ERC-20 governance voting token for Robot Money.
///
/// A simple ERC-20 with an initial supply minted to a designated minter at
/// deploy time. The minter address holds the total supply; no further minting
/// is possible after deployment. Decimals: 18 (standard).
///
/// This token is used in testing/devnet environments to provide voting power
/// to test participants via the faucet tab. It is NOT designed for mainnet
/// deployment without further audit.
contract RmToken {
    // ─── ERC-20 state ────────────────────────────────────────────────────────

    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    // ─── Events ──────────────────────────────────────────────────────────────

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // ─── Constructor ─────────────────────────────────────────────────────────

    /// @param name_        Token name, e.g. "Robot Money Token".
    /// @param symbol_      Token symbol, e.g. "RM".
    /// @param initialHolder Address that receives the entire initial supply.
    /// @param initialSupply Total supply in base units (18 decimals).
    constructor(
        string memory name_,
        string memory symbol_,
        address initialHolder,
        uint256 initialSupply
    ) {
        require(initialHolder != address(0), "RmToken: zero initial holder");
        name = name_;
        symbol = symbol_;
        totalSupply = initialSupply;
        _balances[initialHolder] = initialSupply;
        emit Transfer(address(0), initialHolder, initialSupply);
    }

    // ─── ERC-20 view ─────────────────────────────────────────────────────────

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowances[owner][spender];
    }

    // ─── ERC-20 write ────────────────────────────────────────────────────────

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = _allowances[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "RmToken: insufficient allowance");
            _allowances[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _transfer(address from, address to, uint256 amount) internal {
        require(from != address(0), "RmToken: transfer from zero address");
        require(to != address(0), "RmToken: transfer to zero address");
        require(_balances[from] >= amount, "RmToken: insufficient balance");
        unchecked {
            _balances[from] -= amount;
            _balances[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}
