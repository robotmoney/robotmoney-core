// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.9.3 check 2 (feed health), §5.9.5 (maxFeedAge,
//            sequencerGrace); docs/technical/one-vault-timed-flows-eng-plan.md E16 ("tests move a feed with a mock
//            aggregator placed at the feed's address"); scaffold plan §6 (`P/mocks/*.sol`, integrate writes the
//            aggregator)
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

/// @title MockAggregator
/// @notice A Chainlink `AggregatorV3Interface` stand-in whose round the test sets. The harness places its runtime
///         code at each real Base feed address with `vm.etch` (no constructor, no immutable, so the etched code works
///         and no deployer nonce is used), then writes the round with `setRound`. `FeedLib` reads only `decimals()`
///         and `latestRoundData()`; `description()` is here for probes.
///
///         Every storage field is a full word and every read follows a `setRound`, so a write never needs a read
///         first (no packed field), and on a recorded feed account the fixture coverage check sees writes first.
contract MockAggregator {
    uint256 internal _decimals;
    int256 internal _answer;
    uint256 internal _startedAt;
    uint256 internal _updatedAt;
    uint256 internal _roundId;
    uint256 internal _answeredInRound;

    /// @notice Set the latest round: a complete round (`answeredInRound == roundId == 1`).
    /// @param decimals_  The feed's decimals (8 for a price feed, 0 for the sequencer feed).
    /// @param answer_    The answer in `decimals_` (sequencer feed: 0 = up, 1 = down).
    /// @param startedAt_ Round start (sequencer feed: when the current status began).
    /// @param updatedAt_ Round update time (the age `FeedLib.read` checks).
    function setRound(uint8 decimals_, int256 answer_, uint256 startedAt_, uint256 updatedAt_)
        external
    {
        _decimals = decimals_;
        _answer = answer_;
        _startedAt = startedAt_;
        _updatedAt = updatedAt_;
        _roundId = 1;
        _answeredInRound = 1;
    }

    /// @notice Make the round incomplete (`answeredInRound < roundId`), for a round-completeness test.
    function setIncomplete() external {
        _roundId = 2;
        _answeredInRound = 1;
    }

    function decimals() external view returns (uint8) {
        return uint8(_decimals);
    }

    function description() external pure returns (string memory) {
        return "prototype mock aggregator";
    }

    function version() external pure returns (uint256) {
        return 0;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (uint80(_roundId), _answer, _startedAt, _updatedAt, uint80(_answeredInRound));
    }

    function latestAnswer() external view returns (int256) {
        return _answer;
    }
}
