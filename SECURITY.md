# Security Policy

## Supported Versions

This project is an early prototype. Only the latest `main` branch is actively maintained.

## Reporting Issues

Please report security-sensitive issues privately to the maintainer if possible. If private contact is not available, open a GitHub issue with minimal reproduction details and avoid posting personal paths, proprietary files, game data, or server credentials.

## Local-Only Design

Nostalgia Chart Maker is designed to run locally against folders the user selects. Do not expose the local patcher API to the public internet. The default API host is `127.0.0.1`.

## Sensitive Files

Do not attach or commit:

- game client files
- arcade server files
- extracted assets
- copyrighted songs or jacket art
- personal server configs
- logs containing private paths or credentials

