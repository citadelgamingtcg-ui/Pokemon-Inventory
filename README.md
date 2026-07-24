# PokéInventory

A Pokémon TCG inventory system for tracking Facebook lot purchases, identifying cards via AI, and pulling live TCGPlayer market prices.

## Features

- 📸 **AI Card Identification** — Upload a photo of a lot and Claude identifies every card automatically
- 💰 **Live TCGPlayer Prices** — Market prices pulled in real-time via TCGTracking.com (no API key needed)
- 📦 **Lot Tracking** — Track what you paid per Facebook lot vs. total TCG value
- 📊 **P&L Dashboard** — See profit/loss per lot and per card, with ROI %
- 🔍 **Search & Filter** — Find cards across all lots instantly
- 📤 **Export** — Export your full inventory to CSV

## Setup

No build step needed. It's a single HTML file + supporting JS/CSS.

### Option 1: Open locally
Just open `index.html` in your browser.

### Option 2: GitHub Pages (recommended)
1. Push this repo to GitHub
2. Go to **Settings → Pages**
3. Set source to `main` branch, `/ (root)`
4. Your app will be live at `https://yourusername.github.io/pokeinventory`

## APIs Used

| API | Purpose | Cost |
|-----|---------|------|
| [TCGTracking.com](https://tcgtracking.com/tcgapi/) | Live TCGPlayer market prices | Free, no key needed |
| [Anthropic Claude](https://anthropic.com) | AI card identification from photos | Included via claude.ai |

## File Structure

```
pokeinventory/
├── index.html          # Main app
├── css/
│   └── style.css       # All styles
├── js/
│   ├── app.js          # Core app logic & state
│   ├── api.js          # TCGTracking price lookups
│   ├── ai.js           # Claude AI card identification
│   └── export.js       # CSV export
├── README.md
└── .gitignore
```

## How It Works

1. Click **+ New Lot** and enter what you paid on Facebook
2. Upload a photo of your cards
3. Claude AI scans the photo and identifies each card
4. Live TCGPlayer prices are fetched for each identified card
5. The app calculates your profit/loss for the whole lot and each card individually

## Expanding This App

Planned features:
- [ ] Grading submission tracker (PSA/BGS)
- [ ] eBay comp pricing
- [ ] Bulk CSV import
- [ ] Card condition photo grading via AI
- [ ] Restock alerts for high-value cards
