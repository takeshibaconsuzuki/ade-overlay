# Workflow documentation

## Purpose and scope

- Document product behavior across the desktop app, companion server, and workspace extension. Contributor tooling, builds, and packaging are outside this scope.
- Write for someone who needs to discuss the architecture without reading the implementation. The charts should explain behavior, ownership, major decisions, and ordering; code supplies implementation details.
- Make ease of understanding the deciding factor. Compression, small diagrams, and notation preferences are useful only when they help the reader.
- Describe implemented behavior. Update affected workflows when product behavior changes.

## Organization

- Keep workflow documentation in `workflows/`, with separate pages for significant components and a `README.md` linking to them.
- Give each workflow one canonical home, normally with the component responsible for its outcome. Keep cross-component workflows together rather than splitting them at every component boundary.
- Put shared ownership rules and invariants in short bullets on the relevant component page. Reference them instead of repeating them in every workflow.
- Use meaningful workflow names and stable heading links. Link to the relevant source owners when implementation details would help further investigation.

## Scope and decomposition

- Give each chart a clear scope. Start with a user action or an internal or external event, and follow that invocation to its natural outcome. Several triggers can share a workflow when they initiate the same behavior.
- Make each node a substantial action relative to the chart's scope. An opening workflow may contain "prepare editor"; its preparation chart may contain "start VS Code server" and "wait for readiness."
- Expand an action into its own chart when its internal decisions, ownership, or ordering help explain the architecture. Stop when further expansion would mostly describe implementation mechanics. A named action does not automatically need another chart.
- Separate behavior with its own meaningful trigger or work that continues after its caller finishes. For example, terminal launch, activity reporting, and process-exit reconciliation are separate workflows.
- Give references meaningful action names. Show whether the caller waits for completion, starts work in the background, or emits an event. Show how the referenced workflow's result affects the caller; define its internal behavior in its own chart.
- Keep diagrams small enough to read comfortably at normal size. Split by behavior and scope rather than arbitrary node counts; keep simple actions inline when a reference would add unnecessary navigation.

## Diagram notation and branches

- Use Mermaid sequence diagrams for interactions and ordering, flowcharts for decisions and progression, and state diagrams when resource lifetimes are clearer as states and transitions. Different diagram types may reference each other.
- Choose the notation that best explains the workflow. Avoid duplicating the same behavior in multiple diagram types.
- Reserve explicit branches for major decisions that lead to meaningfully different sequences of actions.
- Compress short offshoots into the relevant node or interaction label when that makes them easier to understand. For example: "If error, roll back; otherwise, publish state."
- Readability overrides compression. Keep a multi-node branch or extract a separate chart when a compressed label becomes difficult to follow. Simple alternatives may remain inside sequence diagrams.
- Omit routine error handling. Include it only when the handling materially affects product behavior, such as retaining a partially created worktree or rolling back a change. Apply the same readability rule to those paths.
- Put outcomes in the charts. Use explicit end nodes in flowcharts and completion interactions or resulting-state annotations in sequence diagrams. Make distinctions such as request acceptance, page readiness, and terminal focus apparent where relevant.

## Scheduling and lifetimes

- Document scheduling in the caller diagram. Show the triggering event or interval and the timing relationships needed to understand execution. Additional details may go in a short prose bullet.
- Diagram one execution of a recurring workflow in the called chart. Keep scheduling and meaningful overlap or coalescing policy with the caller. Use loops only when repetition belongs to the invocation being shown.
- Preserve meaningful distinctions between caller completion and ongoing work. Show ordering, shared work, cancellation, supersession, or disconnection behavior when these change the outcome or what continues afterward.
- Identify the owners of relevant state and resources. Keep authentication and privileged boundaries visible where they matter to the workflow.

## Labels and prose

- Use "in the background" for work that lets its caller continue without waiting. Describe ownership and what survives cancellation or disconnection separately.
- Use short, plain labels that describe actions and results. Name endpoints and commands at relevant boundaries so readers can locate the implementation; leave exhaustive payloads and helper calls in code.
- Keep prose short and easy to understand. Prefer bullets, keep one concept per bullet, and separate unrelated concepts.
- Use prose for context, shared rules, rationale, and details that would clutter the chart. Avoid narrating every arrow or restating outcomes in a separate prose field.
- Keep documentation durable. Leave release identifiers and incidental implementation details in code; include timing when it explains product behavior.

## Review

- Can a reader identify the trigger, responsible owners, major decisions, and outcome from the charts?
- Are timing and invocation relationships clear, including work that runs in the background?
- Does each chart stay at a consistent level of detail for its scope?
- Do branches, compressed labels, and references make the behavior easier to understand?
