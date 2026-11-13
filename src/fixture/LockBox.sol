// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

interface IGate {
    function isOpen() external view returns (bool);
}

/// @title LockBox (fixture, route A source side, Base Sepolia)
/// @notice A deliberately small lock-and-mint bridge fixture we wrote so attacks can be staged on testnet. Labelled
///         fixture everywhere. `lock()` is never gated (like a Hyperlane PausableIsm, which blocks inbound delivery
///         only); relayer releases check gate B.
/// @dev Spike version: amounts are bookkeeping only (no token custody yet); tUSD custody arrives with the core flow.
contract LockBox {
    uint256 public constant MAX_PER_MSG = 500e18;

    address public immutable owner;
    address public relayer;
    IGate public immutable gate;
    uint64 public nonce;
    mapping(uint64 => bool) public released;

    event Locked(uint64 indexed nonce, address indexed to, uint256 amount);
    event Released(uint64 indexed nonce, address indexed to, uint256 amount);

    error GatePaused();
    error OverCap();
    error NotRelayer();
    error AlreadyReleased();

    constructor(address gate_, address relayer_) {
        owner = msg.sender;
        gate = IGate(gate_);
        relayer = relayer_;
    }

    function lock(address to, uint256 amount) external returns (uint64 n) {
        if (amount > MAX_PER_MSG) revert OverCap();
        n = ++nonce;
        emit Locked(n, to, amount);
    }

    function releaseByRelayer(uint64 burnNonce, address to, uint256 amount) external {
        if (msg.sender != relayer) revert NotRelayer();
        if (!gate.isOpen()) revert GatePaused();
        if (amount > MAX_PER_MSG) revert OverCap();
        if (released[burnNonce]) revert AlreadyReleased();
        released[burnNonce] = true;
        emit Released(burnNonce, to, amount);
    }
}
