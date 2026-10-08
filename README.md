# Cloudy's Bazaar Filler

PDA-first Torn City bazaar filler built around one job: fill the whole visible Add Items screen with one tap.

## What it does

- Adds one large **FILL THIS PAGE** button to Torn's Bazaar page.
- Fills every visible Add Items row.
- Uses the maximum quantity detected for each item.
- Prices each item at the current cheapest Item Market listing minus your configured undercut.
- Default undercut: **$1**.
- Uses a 16-character Torn public/limited API key stored locally in your browser/PDA.
- No jQuery or external dependencies.

## Install / Greasy Fork sync

Use this raw file as the Greasy Fork sync source:

`https://raw.githubusercontent.com/gregapackard/torn-bazaar-filler/main/cloudys-bazaar-filler.user.js`

Torn PDA can also install the same userscript file as a remote script.

## Current scope

v0.1 targets the **Bazaar Add Items** page first. Manage Items support can be added separately without bloating the main one-tap workflow.

## Safety behavior

If the script cannot confidently detect an item's available quantity, it skips that row rather than guessing.
