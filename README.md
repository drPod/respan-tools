# Respan CLI

Command-line tool for [Respan](https://respan.ai) — LLM observability platform.

## Install

```bash
npm install -g @respan/cli
```

## Auth

```bash
# Browser login (email, password, or Google)
respan auth login

# Or use an API key
respan auth login
# > select "API Key"

# Or set via environment variable
export RESPAN_API_KEY=your-key
```

## Usage

```bash
# Check who you're logged in as
respan whoami

# List recent logs
respan logs list

# Get a specific log
respan logs get <log-id>

# List traces
respan traces list

# List customers
respan users list

# Manage prompts
respan prompts list
respan prompts get <id>
respan prompts versions <id>

# Manage datasets
respan datasets list
respan datasets spans <id>

# Run evaluators
respan evaluators list
respan evaluators run <id> --dataset-id <dataset-id>
```

## Output Formats

```bash
# Table (default)
respan logs list

# JSON
respan logs list --json

# CSV
respan logs list --csv
```

## Filtering & Pagination

```bash
# Paginate
respan logs list --limit 50 --page 2

# Filter
respan logs list --filter model::gpt-4o --filter cost:gt:0.01

# Time range
respan logs list --start-time 2025-01-01T00:00:00Z --end-time 2025-01-02T00:00:00Z
```

## Profiles

```bash
# Login with a named profile
respan auth login --profile staging

# Use a profile for any command
respan logs list --profile staging

# Check auth status
respan auth status
```

## Config

```bash
respan config list
respan config get <key>
respan config set <key> <value>
```

## License

MIT
