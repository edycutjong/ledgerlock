// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

interface IGate {
    function isOpen() external view returns (bool);
}

/// @title LockBox (fixture, route A source side, Base Sepolia)
/// @notice A deliberately small lock-and-mint bridge fixture we wrote so attacks can be staged on testnet. Labelled
///         fixture everywhere. `lock()` is never gated (like a Hyperlane PausableIsm, which blocks inbound delivery
///         only); every collateral exit (`releaseByRelayer`, `process`) checks gate B.
/// @dev Fixture tUSD is internal bookkeeping (`collateral`), not an ERC-20: what the bench reads is how much collateral
///      left. `process()` reproduces the Nomad-class bug on purpose: after `initialize(bytes32(0))`, `confirmAt[0] = 1`,
///      so any never-proven message (`messages[h] == 0`) passes the root check. Fixture only, labelled.
contract LockBox {
    uint256 public constant MAX_PER_MSG = 500e18;

    address public immutable owner;
    address public relayer;
    IGate public immutable gate;
    uint64 public nonce;
    uint256 public collateral; // fixture tUSD held
    uint256 public totalReleased;
    mapping(uint64 => bool) public released; // burn nonce => released
    mapping(bytes32 => bytes32) public messages; // message hash => root it was proven against (0 = never proven)
    mapping(bytes32 => uint256) public confirmAt; // root => confirmation time (0 = not acceptable)
    mapping(bytes32 => bool) public processed;

    event Locked(uint64 indexed nonce, address indexed to, uint256 amount);
    event Released(uint64 indexed nonce, address indexed to, uint256 amount);
    event CollateralSeeded(uint256 amount);

    error GatePaused();
    error OverCap();
    error NotRelayer();
    error NotOwner();
    error AlreadyReleased();
    error NotProven();
    error Insolvent();

    constructor(address gate_, address relayer_) {
        owner = msg.sender;
        gate = IGate(gate_);
        relayer = relayer_;
    }

    /// @notice Fixture: deposit `amount` tUSD for `to` on the other chain. Never gated.
    function lock(address to, uint256 amount) external returns (uint64 n) {
        if (amount > MAX_PER_MSG) revert OverCap();
        n = ++nonce;
        collateral += amount;
        emit Locked(n, to, amount);
    }

    /// @notice Fixture: seed collateral (the paired control starts both arms from the same balance).
    function seedCollateral(uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        collateral += amount;
        emit CollateralSeeded(amount);
    }

    /// @notice The relayer pays out a burn seen on the other chain.
    function releaseByRelayer(uint64 burnNonce, address to, uint256 amount) external {
        if (msg.sender != relayer) revert NotRelayer();
        if (released[burnNonce]) revert AlreadyReleased();
        released[burnNonce] = true;
        _release(burnNonce, to, amount);
    }

    /// @notice Fixture Nomad-class trusted-root bug. `confirmAt[0] = 1` makes every unproven message acceptable.
    function initialize(bytes32 committedRoot) external {
        if (msg.sender != owner) revert NotOwner();
        confirmAt[committedRoot] = 1;
    }

    /// @notice Permissionless message processing (Nomad-style). message = abi.encode(uint64 burnNonce, address to, uint256 amount).
    function process(bytes calldata message) external {
        bytes32 h = keccak256(message);
        if (confirmAt[messages[h]] == 0) revert NotProven();
        if (processed[h]) revert AlreadyReleased();
        processed[h] = true;
        (uint64 n, address to, uint256 amount) = abi.decode(message, (uint64, address, uint256));
        _release(n, to, amount);
    }

    function _release(uint64 n, address to, uint256 amount) internal {
        if (!gate.isOpen()) revert GatePaused();
        if (amount > MAX_PER_MSG) revert OverCap();
        if (amount > collateral) revert Insolvent();
        collateral -= amount;
        totalReleased += amount;
        emit Released(n, to, amount);
    }
}
