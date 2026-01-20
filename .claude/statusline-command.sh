#!/bin/bash

# Read JSON input from stdin
input=$(cat)

# Extract current working directory
cwd=$(echo "$input" | jq -r '.workspace.current_dir')

# Get git branch (skip optional locks to avoid blocking)
cd "$cwd" 2>/dev/null
git_branch=$(git -c core.fileMode=false symbolic-ref --short HEAD 2>/dev/null || git -c core.fileMode=false rev-parse --short HEAD 2>/dev/null)
if [ -n "$git_branch" ]; then
    git_info=" ($git_branch)"
else
    git_info=""
fi

# Extract token information
usage=$(echo "$input" | jq '.context_window.current_usage')

if [ "$usage" != "null" ]; then
    # Get tokens sent (input tokens for current context)
    tokens_sent=$(echo "$usage" | jq '.input_tokens + .cache_creation_input_tokens + .cache_read_input_tokens')

    # Get tokens received (output tokens)
    tokens_received=$(echo "$usage" | jq '.output_tokens')

    # Calculate total cost (pricing per million tokens for Claude Sonnet 4.5)
    # Input: $3.00/MTok, Output: $15.00/MTok, Cache writes: $3.75/MTok, Cache reads: $0.30/MTok
    input_tokens=$(echo "$usage" | jq '.input_tokens')
    output_tokens=$(echo "$usage" | jq '.output_tokens')
    cache_creation_tokens=$(echo "$usage" | jq '.cache_creation_input_tokens')
    cache_read_tokens=$(echo "$usage" | jq '.cache_read_input_tokens')

    # Calculate cost in dollars (multiply by rate per million, then divide by 1,000,000)
    total_cost=$(echo "scale=3; ($input_tokens * 3.00 + $output_tokens * 15.00 + $cache_creation_tokens * 3.75 + $cache_read_tokens * 0.30) / 1000000" | bc)

    # Format cost with leading zero if needed
    if [ $(echo "$total_cost < 1" | bc) -eq 1 ]; then
        cost_display=$(printf "%.3f" "$total_cost")
    else
        cost_display=$(echo "$total_cost" | awk '{printf "%.3f", $1}')
    fi

    # Calculate context usage percentage
    context_window_size=$(echo "$input" | jq '.context_window.context_window_size')
    context_pct=$((tokens_sent * 100 / context_window_size))

    token_info=" | Sent: ${tokens_sent} | Rcvd: ${tokens_received} | Cost: \$${cost_display} | Context: ${context_pct}%"
else
    token_info=" | Sent: 0 | Rcvd: 0 | Cost: \$0.000 | Context: 0%"
fi

# Output the status line
printf "%s%s%s" "$cwd" "$git_info" "$token_info"
