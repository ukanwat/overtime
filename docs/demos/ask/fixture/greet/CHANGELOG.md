# Changelog

## Unreleased

- Added `--name-file <path>`: greet everyone listed in a file, one name per line.
- Added Portuguese and Hindi greetings (`--lang pt`, `--lang hi`).
- Removed `--shout`. Use `--loud`, which has done the same since 1.2.
- Fixed: names with apostrophes ("O'Brien") were cut short.

## 1.4.2

- Fixed: `--lang` was ignored when `--loud` came first.

## 1.4.1

- Fixed a crash with an empty name.
