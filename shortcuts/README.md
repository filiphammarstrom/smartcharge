# iOS Shortcut – Sätt nästa Tesla-resa

En genväg på hemskärmen som frågar "När åker du?" och "Hur mycket batteri?" och anropar Homey-appen via webhook.

---

## Förutsättningar

- Homey Pro med appen **Tesla Smart Charging** installerad och körs
- Ditt **Homey Cloud ID** (hittas i Homey-appen under Mer → Inställningar → Allmänt → Homey Cloud ID)

---

## Steg-för-steg i Genvägar (iOS Shortcuts)

### 1. Skapa ny genväg

Öppna **Genvägar** → tryck **+** uppe till höger.

Döp genvägen till **Tesla-resa** (tryck på namnfältet högst upp).

---

### 2. Fråga om avgångstid

Lägg till åtgärden **"Fråga om inmatning"** (Ask for Input):

| Fält | Värde |
|------|-------|
| Fråga | `När åker du?` |
| Inmatningstyp | **Datum och tid** |
| Standard | *(lämna tomt)* |

Namnge resultatet **avgångstid** (tryck på variabeln och välj "Byt namn på genväg…" → Nej, döp bara variabeln).

> Praktiskt: Tryck på variabeln efter åtgärden → välj **"avgångstid"** som variabelnamn, eller kom ihåg att den automatiskt heter "Provided Input".

---

### 3. Formatera tiden som ISO 8601

Lägg till åtgärden **"Formatera datum"** (Format Date):

| Fält | Värde |
|------|-------|
| Datum | Välj variabeln från steg 2 (Provided Input) |
| Format | **ISO 8601** |
| Inklusive tid | På |

Döp resultatet till **isoTid**.

---

### 4. Fråga om mål-batteri

Lägg till en ny **"Fråga om inmatning"** (Ask for Input):

| Fält | Värde |
|------|-------|
| Fråga | `Hur mycket batteri behöver du? (%)` |
| Inmatningstyp | **Nummer** |
| Standard | `80` |

Döp resultatet till **batteri**.

---

### 5. Bygg JSON-bodyn

Lägg till åtgärden **"Text"** (Text) och skriv:

```
{"departureTime":"[isoTid]","targetPercent":[batteri]}
```

Ersätt `[isoTid]` med variabeln **isoTid** (tryck in i texten → Välj variabel → isoTid) och `[batteri]` med variabeln **batteri**.

Döp resultatet till **jsonBody**.

---

### 6. Anropa Homey-webhook

Lägg till åtgärden **"Hämta innehåll från URL"** (Get Contents of URL):

| Fält | Värde |
|------|-------|
| URL | `https://DITT-HOMEY-ID.connect.athom.com/api/app/com.filiphammarstrom.teslacharging/trip` |
| Metod | **POST** |
| Sidhuvuden | Lägg till: `Content-Type` = `application/json` |
| Begärandeinnehåll | Välj **"Text"** (inte JSON) → välj variabeln **jsonBody** |

> Byt ut `DITT-HOMEY-ID` mot ditt faktiska Homey Cloud ID (t.ex. `abc123def456`).

**OBS:** Välj "Text" som typ för begärandeinnehåll (inte "JSON-ordlista"), annars formateras inte värdena rätt.

---

### 7. Visa bekräftelse

Lägg till åtgärden **"Visa avisering"** (Show Notification) eller **"Visa varning"** (Show Alert):

```
Resa satt! Avgång [avgångstid], mål [batteri]%
```

Ersätt hakparenteserna med respektive variabel.

---

### 8. Lägg till på hemskärmen

Tryck på **dela-ikonen** (rutan med pil upp) uppe till höger → **"Lägg till på hemskärmen"**.

Välj ikon och namn → **Lägg till**.

---

## Exempelanrop (för testning med curl)

```bash
curl -X POST \
  "https://DITT-HOMEY-ID.connect.athom.com/api/app/com.filiphammarstrom.teslacharging/trip" \
  -H "Content-Type: application/json" \
  -d '{"departureTime":"2026-04-08T09:00:00.000Z","targetPercent":80}'
```

Förväntat svar:
```json
{"ok":true,"trip":{"departureTime":"2026-04-08T09:00:00.000Z","targetPercent":80}}
```

---

## Radera en resa

För att radera en inlagd resa, skapa en separat genväg med en **DELETE**-förfrågan:

| Fält | Värde |
|------|-------|
| URL | `https://DITT-HOMEY-ID.connect.athom.com/api/app/com.filiphammarstrom.teslacharging/trip` |
| Metod | **DELETE** |

---

## Kontrollera status

GET-anrop för att se nuvarande batteri, senaste beslut och aktiv resa:

```bash
curl "https://DITT-HOMEY-ID.connect.athom.com/api/app/com.filiphammarstrom.teslacharging/status"
```
