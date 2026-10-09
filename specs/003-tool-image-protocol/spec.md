# Feature Specification: Tool Image Protocol Repair

**Feature Branch**: `codex/cogseed-341-tool-image`

**Created**: 2026-09-21

**Status**: Complete

**Input**: CogSeed task COGSEED-341 and `BUGFIX_TOOL_IMAGE_PROTOCOL.md`

## User Scenarios & Testing

### User Story 1 - Mixed tool results remain valid (Priority: P1)

As a user running an agent that calls multiple tools in one model turn, I need image-producing tools and text-producing tools to complete without causing the next model request to fail with HTTP 400.

**Why this priority**: The current ordering can make otherwise successful agent runs unrecoverable at the provider boundary.

**Independent Test**: Run an agent turn with two or more tool calls where one returns text plus an image and another returns text, then inspect the next provider request.

**Acceptance Scenarios**:

1. **Given** one assistant turn with parallel image and text tools, **When** all results are committed, **Then** every tool result is contiguous before any image user message.
2. **Given** the image tool appears first, middle, or last, **When** the next model request is built, **Then** every tool call has exactly one matching result and no tool result appears after an image message.
3. **Given** sequential tools from the same assistant turn, **When** one result contains images, **Then** existing execution order is preserved while the protocol ordering remains valid.

### Edge Cases

- Multiple tools each return one or more images.
- A tool fails or aborts after another tool produced an image.
- A terminal tool causes later sibling calls to receive synthetic skipped results.
- A single image-returning tool continues to preserve the image for vision-capable models.

## Requirements

### Functional Requirements

- **FR-001**: The system MUST emit all tool results for one assistant tool-call turn before emitting image user messages produced by those tools.
- **FR-002**: The system MUST preserve declared tool-call order for tool results and associated image order.
- **FR-003**: The system MUST retain image content for vision-capable providers and preserve existing non-vision degradation behavior.
- **FR-004**: The system MUST preserve sequential barriers, parallel execution, terminal-tool skips, and error handling.
- **FR-005**: The system MUST include automated regression coverage for image tools at the first, middle, and last positions and for sequential mixed tools.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Regression tests show no `user/image -> tool_result` ordering for covered mixed-tool scenarios.
- **SC-002**: Existing core-agent session and parallel-tool tests remain green.
- **SC-003**: No changes are made to `node_modules`, tool parallelism policy, or image availability.

## Assumptions

- Tool images remain represented as user image messages because provider-native tool result channels do not consistently accept images.
- A single assistant tool-call turn is the protocol boundary for deferring image messages.
