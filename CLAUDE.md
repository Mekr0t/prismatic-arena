# CLAUDE.md

## Project overview

This is a general-purpose software project.  
You are an AI coding assistant helping with design, implementation, debugging, and documentation.

## How to interact

- Ask clarifying questions when requirements are ambiguous or missing.
- Prefer small, incremental changes over large rewrites.
- When editing files, show:
  - A brief explanation of the change.
  - Unified diffs or clearly marked code blocks.
- If you are unsure, state your uncertainty and suggest options.

## Coding style

- Follow existing style in the file you are editing.
- Use clear, descriptive names for functions, classes, and variables.
- Add comments only where they clarify non-obvious logic or constraints.
- Keep functions focused; avoid very large, multi-purpose functions.

## File handling

- Never invent file paths or APIs; infer from the repository when possible, otherwise ask.
- When you need to inspect a file you have not seen yet, ask me to open it or quote it.
- When proposing new files, include:
  - The full relative path.
  - A short description of the file’s purpose.

## Testing and safety

- When you modify code, suggest at least one test or manual check.
- Call out any potential breaking changes or assumptions.
- Prefer solutions that are simple, maintainable, and easy to revert.

## Non-goals

- Do not introduce new external dependencies unless explicitly requested or clearly justified.
- Do not perform large refactors without first proposing a plan and waiting for confirmation.

## System Manual

A file `SYSTEM_MANUAL.md` exists at the project root. It documents the full
architecture: stack, directory map, CSS partials, every exported function, and
key invariants.

**Before any change:**
- Read `SYSTEM_MANUAL.md` in full.
- Check if the relevant section (CSS, component, lib, server, page) describes
  what you are about to modify. Flag any contradiction before proceeding.

**After any structural change:**
Update the relevant section in `SYSTEM_MANUAL.md` if you:
- Add, rename, or delete a file.
- Add, rename, or remove an exported function, type, or constant.
- Change a CSS class name or move styles to a different partial.
- Add a new dependency, route, or API endpoint.

Do not update the manual for internal refactors that don't change the
public-facing API or file structure.