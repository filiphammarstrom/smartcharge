# Tesla Smart Charging – MCP-server

Gör att du kan styra laddningen direkt i Claude Desktop genom att bara berätta om resor.

## Installation

### 1. Klona/kopiera mcp-server-mappen till din Mac

### 2. Installera beroenden
```bash
cd mcp-server
npm install
```

### 3. Hitta din Homey-URL och token
1. Öppna Homey-appen → **Mer** → **Inställningar** → **Experimentellt** → **Homey Developer Tools**  
   (eller gå till [developer.homey.app](https://developer.homey.app))
2. Kopiera din **Cloud ID** → URL blir `https://<cloudId>.api.athom.com`
3. Skapa ett **Personal Access Token** under API-sektionen

### 4. Lägg till i Claude Desktop

Öppna `~/Library/Application Support/Claude/claude_desktop_config.json` och lägg till:

```json
{
  "mcpServers": {
    "tesla-smartcharge": {
      "command": "node",
      "args": ["/ABSOLUT/SÖKVÄG/mcp-server/index.js"],
      "env": {
        "HOMEY_URL": "https://<din-cloud-id>.api.athom.com",
        "HOMEY_TOKEN": "<ditt-personal-access-token>"
      }
    }
  }
}
```

Ersätt `/ABSOLUT/SÖKVÄG/` med faktisk sökväg till mappen, t.ex. `/Users/filip/smartcharge`.

### 5. Starta om Claude Desktop

---

## Användning

Säg bara till Claude:

- *"Ska till Göteborg på lördag kl 8"*
- *"Boka en resa till Uppsala imorgon 07:30"*
- *"Hur är batteriet?"*
- *"Visa elpriserna för ikväll"*
- *"Ta bort resan"*

## Tillgängliga verktyg

| Verktyg | Beskrivning |
|---|---|
| `set_trip` | Sätter resa (destination eller km + avgångstid) |
| `delete_trip` | Raderar aktiv resa |
| `get_status` | Batteri, laddstatus, senaste AI-beslut |
| `get_prices` | Kommande elpriser (36h) |

## Kända destinationer (avstånd från Stockholm)

Uppsala 70 km · Enköping 85 km · Västerås 110 km · Norrköping 165 km · Gävle 180 km ·  
Örebro 200 km · Linköping 200 km · Jönköping 320 km · Sundsvall 390 km ·  
Göteborg 470 km · Malmö 610 km · Umeå 650 km

Saknas din destination? Ange km direkt: *"550 km, avreser fredag 09:00"*
