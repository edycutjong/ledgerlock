// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

interface IGateU {
    function isOpen() external view returns (bool);
}

/// @title Minter (fixture, route A destination side, Unichain Sepolia)
/// @notice Mints the wrapped fixture token when the relayer reports a lock. A compromised relayer key is the attack the
///         fixture stages: a mint whose lock never happened. Every mint checks gate U. Burning is never gated (it is the
///         inbound side of the release direction). `seize` is the operator's remedy for attack proceeds.
/// @dev The relayer is authenticated by address (the stolen key IS the attack model). Nonces are deduped, so a live
///      replay of a used nonce reverts here; replay / same-key cases are log-level Test Lib cases.
contract Minter {
    uint256 public constant MAX_PER_MSG = 500e18;

    address public immutable owner;
    address public relayer;
    IGateU public immutable gate;
    uint64 public burnNonce;
    mapping(uint64 => bool) public mintedNonce;
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    event Minted(uint64 indexed nonce, address indexed to, uint256 amount);
    event Burned(uint64 indexed nonce, address indexed to, uint256 amount);
    event Seized(address indexed holder, uint256 amount);

    error GatePaused();
    error OverCap();
    error NotRelayer();
    error NotOwner();
    error NonceUsed();
    error Insufficient();

    constructor(address gate_, address relayer_) {
        owner = msg.sender;
        gate = IGateU(gate_);
        relayer = relayer_;
    }

    function mint(uint64 lockNonce, address to, uint256 amount) external {
        if (msg.sender != relayer) revert NotRelayer();
        if (!gate.isOpen()) revert GatePaused();
        if (amount > MAX_PER_MSG) revert OverCap();
        if (mintedNonce[lockNonce]) revert NonceUsed();
        mintedNonce[lockNonce] = true;
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Minted(lockNonce, to, amount);
    }

    /// @notice Burn wrapped tokens to be released to `to` on the source chain.
    function burn(address to, uint256 amount) external returns (uint64 n) {
        if (amount > MAX_PER_MSG) revert OverCap();
        if (balanceOf[msg.sender] < amount) revert Insufficient();
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        n = ++burnNonce;
        emit Burned(n, to, amount);
    }

    /// @notice Operator remedy: burn attack proceeds from a holder (lowers the guard's unbacked figure via `Seized`).
    function seize(address holder, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        if (balanceOf[holder] < amount) revert Insufficient();
        balanceOf[holder] -= amount;
        totalSupply -= amount;
        emit Seized(holder, amount);
    }
}
