---
name: windows-word-docx
description: Create a Microsoft Word-compatible DOCX document offline on Windows from UTF-8 plain text or a small Markdown subset. Use when the user asks to generate a Word document and only built-in Windows PowerShell can be assumed to exist.
---

# Windows Word DOCX

Create a new `.docx` without requiring Microsoft Word, Python, Node.js, npm, or network access.

## Workflow

1. Write the requested content to a UTF-8 text file in the selected workspace.
2. Use this supported input syntax:
   - `# Title`
   - `## Heading 1`
   - `### Heading 2`
   - `#### Heading 3`
   - `- bullet item`
   - `1. numbered item`
   - Any other non-empty line becomes a body paragraph.
3. Run the bundled generator:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<skill-dir>\scripts\New-Docx.ps1" `
  -InputPath "<absolute-input.txt>" `
  -OutputPath "<absolute-output.docx>"
```

4. Confirm the command reports `Created DOCX` and that the output file exists.
5. Return the `.docx` path to the user.

Use `-Title "..."` only when the input does not already start with a `#` title.

## Boundaries

- Create new text-focused documents only.
- Do not claim support for editing an existing DOCX, images, tables, comments, tracked changes, or exact template fidelity.
- Preserve the UTF-8 input file beside the output when the user may want revisions.
- If the user needs advanced Word automation and Microsoft Word is installed, explain that a separate Word COM workflow is required.

## Verification

The generator validates the required ZIP entries and parses the generated XML before returning success. If it fails, report the PowerShell error and do not present the output as a valid Word document.
