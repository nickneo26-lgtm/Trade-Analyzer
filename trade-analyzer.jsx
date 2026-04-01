import { useState, useMemo, useCallback } from "react";
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ScatterChart, Scatter, Legend } from "recharts";

const COLORS = {
  bg: "#0a0f1a",
  card: "#111827",
  cardBorder: "#1e293b",
  green: "#10b981",
  greenMuted: "rgba(16,185,129,0.15)",
  red: "#ef4444",
  redMuted: "rgba(239,68,68,0.15)",
  blue: "#3b82f6",
  purple: "#8b5cf6",
  amber: "#f59e0b",
  cyan: "#06b6d4",
  text: "#e2e8f0",
  textMuted: "#94a3b8",
  textDim: "#64748b",
  accent: "#3b82f6",
};

const CHART_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#f97316"];

const fmt = (n, decimals = 2) => {
  if (n == null || isNaN(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};
const fmtUsd = (n) => {
  if (n == null || isNaN(n)) return "—";
  const prefix = n >= 0 ? "+$" : "-$";
  return prefix + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const fmtPct = (n) => (n == null || isNaN(n) ? "—" : (n >= 0 ? "+" : "") + fmt(n, 1) + "%");

// Parse CSV text into array of objects
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  
  // Handle quoted fields properly
  function parseLine(line) {
    const fields = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());
    return fields;
  }

  const headers = parseLine(lines[0]).map(h => h.replace(/^"|"$/g, '').trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || "";
    });
    rows.push(row);
  }
  return rows;
}

// Auto-detect column mapping from headers
function detectColumns(headers) {
  const lower = headers.map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const find = (keywords) => {
    for (const kw of keywords) {
      const idx = lower.findIndex(h => h.includes(kw));
      if (idx >= 0) return headers[idx];
    }
    return null;
  };
  return {
    date: find(["activitydate", "tradedate", "date", "time", "transdate", "executiondate"]),
    instrument: find(["instrument", "symbol", "ticker", "security", "name", "description"]),
    side: find(["transcode", "side", "action", "type", "transactiontype", "buysell"]),
    quantity: find(["quantity", "qty", "shares", "amount"]),
    price: find(["price", "executionprice", "fillprice", "avgprice"]),
    total: find(["amount", "total", "netamount", "proceeds", "value", "cost"]),
    description: find(["description", "desc", "detail", "memo"]),
  };
}

// Process raw rows into normalized trades
function normalizeTrades(rows, colMap) {
  const trades = [];
  for (const row of rows) {
    const dateStr = row[colMap.date] || "";
    const instrument = row[colMap.instrument] || row[colMap.description] || "";
    const sideRaw = (row[colMap.side] || "").toUpperCase();
    const desc = (row[colMap.description] || row[colMap.instrument] || "").toUpperCase();
    
    // Skip non-trade rows
    if (!instrument && !desc) continue;
    if (desc.includes("DIVIDEND") || desc.includes("INTEREST") || desc.includes("FEE") || desc.includes("TRANSFER") || desc.includes("DEPOSIT") || desc.includes("WITHDRAWAL") || desc.includes("JOURNAL") || desc.includes("ACH") || desc.includes("MARGIN")) continue;
    if (sideRaw.includes("DIV") || sideRaw.includes("INT")) continue;
    
    // Determine side
    let side = null;
    if (sideRaw.includes("BUY") || sideRaw === "BTO" || sideRaw === "B") side = "BUY";
    else if (sideRaw.includes("SELL") || sideRaw === "STC" || sideRaw === "S" || sideRaw === "STO" || sideRaw === "BTC") side = "SELL";
    else if (sideRaw === "STO" || sideRaw === "BTC") side = sideRaw; // options
    
    // For Robinhood, sometimes side is embedded in description
    if (!side) {
      if (desc.includes("BOUGHT") || desc.includes("BUY")) side = "BUY";
      else if (desc.includes("SOLD") || desc.includes("SELL")) side = "SELL";
    }
    if (!side) continue;

    const qty = Math.abs(parseFloat((row[colMap.quantity] || "0").replace(/[,$]/g, '')));
    const price = Math.abs(parseFloat((row[colMap.price] || "0").replace(/[,$]/g, '')));
    const total = parseFloat((row[colMap.total] || "0").replace(/[,$()]/g, ''));
    
    if (qty === 0 && price === 0 && total === 0) continue;

    // Determine if option
    const isOption = desc.includes("CALL") || desc.includes("PUT") || desc.includes("OPTION") || 
                     sideRaw === "BTO" || sideRaw === "STC" || sideRaw === "STO" || sideRaw === "BTC" ||
                     /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(instrument) || /\$\d+/.test(instrument) ||
                     /[CP]\s*\d/.test(instrument);

    // Extract base ticker
    let ticker = instrument.split(/\s+/)[0].replace(/[^A-Za-z]/g, '').toUpperCase();
    if (!ticker && desc) ticker = desc.split(/\s+/)[0].replace(/[^A-Za-z]/g, '').toUpperCase();

    const date = new Date(dateStr);
    if (isNaN(date.getTime())) continue;

    trades.push({
      date,
      dateStr: date.toISOString().split("T")[0],
      ticker,
      instrument: instrument || desc,
      side: side.includes("SELL") || side === "STC" || side === "STO" ? "SELL" : "BUY",
      isShort: side === "STO" || side === "BTC",
      quantity: qty,
      price,
      total: total || (side.includes("SELL") || side === "STC" ? qty * price : -(qty * price)),
      isOption,
      type: isOption ? "Option" : "Equity",
      description: desc,
    });
  }
  return trades.sort((a, b) => a.date - b.date);
}

// Group trades into round-trips using FIFO
function groupRoundTrips(trades) {
  const positions = {};
  const roundTrips = [];

  for (const t of trades) {
    const key = t.isOption ? t.instrument : t.ticker;
    if (!key) continue;
    if (!positions[key]) positions[key] = { buys: [], ticker: t.ticker, type: t.type, instrument: t.instrument };

    if (t.side === "BUY") {
      positions[key].buys.push({ ...t, remainingQty: t.quantity });
    } else {
      let sellQty = t.quantity;
      let totalCost = 0;
      let totalProceeds = t.quantity * t.price;
      let entryDate = null;

      const buys = positions[key].buys;
      while (sellQty > 0 && buys.length > 0) {
        const buy = buys[0];
        if (!entryDate) entryDate = buy.date;
        const matched = Math.min(sellQty, buy.remainingQty);
        totalCost += matched * buy.price;
        buy.remainingQty -= matched;
        sellQty -= matched;
        if (buy.remainingQty <= 0) buys.shift();
      }

      if (entryDate) {
        const multiplier = t.isOption ? 100 : 1;
        const pnl = (totalProceeds - totalCost) * (t.isOption && !t.instrument.includes("100") ? multiplier : 1);
        const holdDays = Math.max(0, Math.round((t.date - entryDate) / (1000 * 60 * 60 * 24)));
        
        // Use simpler P&L for non-option trades
        const simplePnl = t.isOption ? pnl : totalProceeds - totalCost;

        roundTrips.push({
          ticker: positions[key].ticker,
          type: positions[key].type,
          entryDate,
          exitDate: t.date,
          exitDateStr: t.dateStr,
          holdDays,
          pnl: simplePnl,
          pnlPct: totalCost > 0 ? ((totalProceeds - totalCost) / totalCost) * 100 : 0,
          isWin: simplePnl > 0,
          cost: totalCost,
          proceeds: totalProceeds,
          quantity: t.quantity,
        });
      }
    }
  }
  return roundTrips;
}

// Stat card component
function StatCard({ label, value, subtext, color }) {
  return (
    <div style={{ background: COLORS.card, border: `1px solid ${COLORS.cardBorder}`, borderRadius: 12, padding: "16px 20px" }}>
      <div style={{ fontSize: 12, color: COLORS.textDim, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: color || COLORS.text, fontFamily: "'JetBrains Mono', 'SF Mono', monospace" }}>{value}</div>
      {subtext && <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 4 }}>{subtext}</div>}
    </div>
  );
}

// Custom tooltip
function ChartTooltip({ active, payload, label, formatter }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", fontSize: 13 }}>
      <div style={{ color: COLORS.textMuted, marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color || COLORS.text }}>
          {p.name}: {formatter ? formatter(p.value) : p.value}
        </div>
      ))}
    </div>
  );
}

// Sample data for demo
const SAMPLE_CSV = `Activity Date,Process Date,Settle Date,Instrument,Description,Trans Code,Quantity,Price,Amount
01/05/2024,01/05/2024,01/08/2024,AAPL,AAPL - Apple Inc,Buy,50,185.50,-9275.00
01/18/2024,01/18/2024,01/22/2024,AAPL,AAPL - Apple Inc,Sell,50,192.30,9615.00
01/08/2024,01/08/2024,01/10/2024,TSLA,TSLA - Tesla Inc,Buy,30,238.00,-7140.00
01/25/2024,01/25/2024,01/29/2024,TSLA,TSLA - Tesla Inc,Sell,30,207.50,6225.00
01/12/2024,01/12/2024,01/16/2024,NVDA,NVDA - NVIDIA Corp,Buy,40,548.00,-21920.00
02/02/2024,02/02/2024,02/06/2024,NVDA,NVDA - NVIDIA Corp,Sell,40,661.20,26448.00
01/15/2024,01/15/2024,01/17/2024,SPY,SPY 01/19/24 Call $475,BTO,5,3.20,-1600.00
01/19/2024,01/19/2024,01/22/2024,SPY,SPY 01/19/24 Call $475,STC,5,5.80,2900.00
02/01/2024,02/01/2024,02/05/2024,MSFT,MSFT - Microsoft,Buy,25,404.00,-10100.00
02/15/2024,02/15/2024,02/20/2024,MSFT,MSFT - Microsoft,Sell,25,411.50,10287.50
02/05/2024,02/05/2024,02/07/2024,AMD,AMD - Advanced Micro,Buy,60,174.50,-10470.00
02/28/2024,02/28/2024,03/01/2024,AMD,AMD - Advanced Micro,Sell,60,198.20,11892.00
02/10/2024,02/10/2024,02/12/2024,AMZN,AMZN - Amazon,Buy,35,169.00,-5915.00
02/22/2024,02/22/2024,02/26/2024,AMZN,AMZN - Amazon,Sell,35,174.50,6107.50
03/01/2024,03/01/2024,03/04/2024,META,META - Meta Platforms,Buy,20,502.00,-10040.00
03/15/2024,03/15/2024,03/18/2024,META,META - Meta Platforms,Sell,20,484.00,9680.00
03/05/2024,03/05/2024,03/07/2024,TSLA,TSLA - Tesla Inc,Buy,40,188.00,-7520.00
03/18/2024,03/18/2024,03/20/2024,TSLA,TSLA - Tesla Inc,Sell,40,163.50,6540.00
03/08/2024,03/08/2024,03/11/2024,NVDA,NVDA 03/15/24 Call $850,BTO,3,12.50,-3750.00
03/14/2024,03/14/2024,03/18/2024,NVDA,NVDA 03/15/24 Call $850,STC,3,28.40,8520.00
03/10/2024,03/10/2024,03/12/2024,GOOGL,GOOGL - Alphabet,Buy,30,138.50,-4155.00
03/28/2024,03/28/2024,03/29/2024,GOOGL,GOOGL - Alphabet,Sell,30,155.70,4671.00
04/01/2024,04/01/2024,04/03/2024,AAPL,AAPL - Apple Inc,Buy,45,170.00,-7650.00
04/12/2024,04/12/2024,04/15/2024,AAPL,AAPL - Apple Inc,Sell,45,167.50,7537.50
04/05/2024,04/05/2024,04/08/2024,MSFT,MSFT - Microsoft,Buy,20,425.50,-8510.00
04/22/2024,04/22/2024,04/24/2024,MSFT,MSFT - Microsoft,Sell,20,410.00,8200.00
04/08/2024,04/08/2024,04/10/2024,SPY,SPY 04/19/24 Put $510,BTO,8,4.50,-3600.00
04/16/2024,04/16/2024,04/18/2024,SPY,SPY 04/19/24 Put $510,STC,8,7.20,5760.00
04/15/2024,04/15/2024,04/17/2024,AMD,AMD - Advanced Micro,Buy,50,162.00,-8100.00
04/30/2024,04/30/2024,05/02/2024,AMD,AMD - Advanced Micro,Sell,50,157.00,7850.00
05/01/2024,05/01/2024,05/03/2024,NVDA,NVDA - NVIDIA Corp,Buy,25,860.00,-21500.00
05/20/2024,05/20/2024,05/22/2024,NVDA,NVDA - NVIDIA Corp,Sell,25,949.50,23737.50
05/05/2024,05/05/2024,05/07/2024,TSLA,TSLA - Tesla Inc,Buy,35,180.00,-6300.00
05/15/2024,05/15/2024,05/17/2024,TSLA,TSLA - Tesla Inc,Sell,35,176.50,6177.50
05/10/2024,05/10/2024,05/13/2024,COIN,COIN - Coinbase,Buy,40,225.00,-9000.00
05/28/2024,05/28/2024,05/30/2024,COIN,COIN - Coinbase,Sell,40,248.00,9920.00
06/03/2024,06/03/2024,06/05/2024,NVDA,NVDA 06/21/24 Call $1100,BTO,4,22.00,-8800.00
06/18/2024,06/18/2024,06/20/2024,NVDA,NVDA 06/21/24 Call $1100,STC,4,45.50,18200.00
06/10/2024,06/10/2024,06/12/2024,SMCI,SMCI - Super Micro,Buy,15,820.00,-12300.00
06/25/2024,06/25/2024,06/27/2024,SMCI,SMCI - Super Micro,Sell,15,780.00,11700.00
07/01/2024,07/01/2024,07/03/2024,AAPL,AAPL - Apple Inc,Buy,30,215.00,-6450.00
07/15/2024,07/15/2024,07/17/2024,AAPL,AAPL - Apple Inc,Sell,30,228.50,6855.00
07/08/2024,07/08/2024,07/10/2024,PLTR,PLTR - Palantir,Buy,100,26.50,-2650.00
07/22/2024,07/22/2024,07/24/2024,PLTR,PLTR - Palantir,Sell,100,27.80,2780.00`;

export default function TradeAnalyzer() {
  const [rawData, setRawData] = useState(null);
  const [trades, setTrades] = useState([]);
  const [roundTrips, setRoundTrips] = useState([]);
  const [activeTab, setActiveTab] = useState("overview");
  const [error, setError] = useState(null);
  const [fileName, setFileName] = useState(null);
  const [isDemo, setIsDemo] = useState(false);

  const processData = useCallback((text, name) => {
    try {
      const rows = parseCSV(text);
      if (rows.length === 0) throw new Error("No data rows found in CSV");
      
      const headers = Object.keys(rows[0]);
      const colMap = detectColumns(headers);
      
      if (!colMap.date) throw new Error("Could not find a date column. Expected: Activity Date, Trade Date, Date, etc.");
      
      const normalized = normalizeTrades(rows, colMap);
      if (normalized.length === 0) throw new Error("No valid trades found. Check that your CSV has buy/sell transactions.");
      
      const trips = groupRoundTrips(normalized);
      
      setRawData(rows);
      setTrades(normalized);
      setRoundTrips(trips);
      setFileName(name);
      setError(null);
      setActiveTab("overview");
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setIsDemo(false);
    const reader = new FileReader();
    reader.onload = (ev) => processData(ev.target.result, file.name);
    reader.readAsText(file);
  };

  const loadDemo = () => {
    setIsDemo(true);
    processData(SAMPLE_CSV, "demo_trades.csv");
  };

  // Compute analytics
  const analytics = useMemo(() => {
    if (roundTrips.length === 0) return null;
    const wins = roundTrips.filter(t => t.isWin);
    const losses = roundTrips.filter(t => !t.isWin);
    const totalPnl = roundTrips.reduce((s, t) => s + t.pnl, 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
    const profitFactor = avgLoss > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : Infinity;
    const avgHoldWin = wins.length ? wins.reduce((s, t) => s + t.holdDays, 0) / wins.length : 0;
    const avgHoldLoss = losses.length ? losses.reduce((s, t) => s + t.holdDays, 0) / losses.length : 0;
    const expectancy = roundTrips.reduce((s, t) => s + t.pnl, 0) / roundTrips.length;

    // By ticker
    const byTicker = {};
    roundTrips.forEach(t => {
      if (!byTicker[t.ticker]) byTicker[t.ticker] = { ticker: t.ticker, pnl: 0, count: 0, wins: 0 };
      byTicker[t.ticker].pnl += t.pnl;
      byTicker[t.ticker].count++;
      if (t.isWin) byTicker[t.ticker].wins++;
    });
    const tickerData = Object.values(byTicker).sort((a, b) => b.pnl - a.pnl);

    // By type
    const equityTrips = roundTrips.filter(t => t.type === "Equity");
    const optionTrips = roundTrips.filter(t => t.type === "Option");
    const equityPnl = equityTrips.reduce((s, t) => s + t.pnl, 0);
    const optionPnl = optionTrips.reduce((s, t) => s + t.pnl, 0);

    // Cumulative P&L over time
    const sorted = [...roundTrips].sort((a, b) => a.exitDate - b.exitDate);
    let cum = 0;
    const cumPnl = sorted.map(t => {
      cum += t.pnl;
      return { date: t.exitDateStr, pnl: cum, tradePnl: t.pnl };
    });

    // Monthly returns
    const monthly = {};
    sorted.forEach(t => {
      const m = t.exitDateStr.substring(0, 7);
      if (!monthly[m]) monthly[m] = { month: m, pnl: 0, count: 0, wins: 0 };
      monthly[m].pnl += t.pnl;
      monthly[m].count++;
      if (t.isWin) monthly[m].wins++;
    });
    const monthlyData = Object.values(monthly);

    // Hold time vs P&L scatter
    const holdScatter = roundTrips.map(t => ({
      holdDays: t.holdDays,
      pnl: t.pnl,
      ticker: t.ticker,
      type: t.type,
    }));

    // Top winners and losers
    const sortedByPnl = [...roundTrips].sort((a, b) => b.pnl - a.pnl);
    const topWins = sortedByPnl.slice(0, 5);
    const topLosses = sortedByPnl.slice(-5).reverse();

    // Streak analysis
    let currentStreak = 0;
    let maxWinStreak = 0;
    let maxLossStreak = 0;
    sorted.forEach(t => {
      if (t.isWin) {
        currentStreak = currentStreak > 0 ? currentStreak + 1 : 1;
        maxWinStreak = Math.max(maxWinStreak, currentStreak);
      } else {
        currentStreak = currentStreak < 0 ? currentStreak - 1 : -1;
        maxLossStreak = Math.max(maxLossStreak, Math.abs(currentStreak));
      }
    });

    // Max drawdown
    let peak = 0;
    let maxDD = 0;
    cum = 0;
    sorted.forEach(t => {
      cum += t.pnl;
      peak = Math.max(peak, cum);
      maxDD = Math.min(maxDD, cum - peak);
    });

    return {
      totalPnl, winRate: (wins.length / roundTrips.length) * 100,
      avgWin, avgLoss, profitFactor, expectancy,
      totalTrades: roundTrips.length, wins: wins.length, losses: losses.length,
      avgHoldWin, avgHoldLoss,
      equityPnl, optionPnl, equityCount: equityTrips.length, optionCount: optionTrips.length,
      tickerData, cumPnl, monthlyData, holdScatter,
      topWins, topLosses, maxWinStreak, maxLossStreak, maxDrawdown: maxDD,
    };
  }, [roundTrips]);

  // Upload screen
  if (!analytics) {
    return (
      <div style={{ minHeight: "100vh", background: COLORS.bg, color: COLORS.text, fontFamily: "'Inter', -apple-system, sans-serif", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ maxWidth: 520, width: "100%", textAlign: "center" }}>
          <div style={{ fontSize: 13, color: COLORS.accent, textTransform: "uppercase", letterSpacing: 2, marginBottom: 8 }}>Trade Analyzer</div>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: "0 0 8px", color: COLORS.text }}>Find Your Real Edge</h1>
          <p style={{ color: COLORS.textMuted, marginBottom: 32, fontSize: 15, lineHeight: 1.6 }}>
            Upload your Robinhood CSV export to see where you actually make money — and where you're bleeding it.
          </p>

          <label style={{
            display: "block", padding: "48px 24px", border: `2px dashed ${COLORS.cardBorder}`, borderRadius: 16,
            background: COLORS.card, cursor: "pointer", transition: "border-color 0.2s",
            marginBottom: 16,
          }}
            onMouseOver={e => e.currentTarget.style.borderColor = COLORS.accent}
            onMouseOut={e => e.currentTarget.style.borderColor = COLORS.cardBorder}
          >
            <input type="file" accept=".csv" onChange={handleFileUpload} style={{ display: "none" }} />
            <div style={{ fontSize: 40, marginBottom: 12 }}>📂</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Drop your CSV here or click to upload</div>
            <div style={{ fontSize: 13, color: COLORS.textDim }}>Robinhood → Account → Statements & History → Download</div>
          </label>

          <button onClick={loadDemo} style={{
            background: "transparent", border: `1px solid ${COLORS.cardBorder}`, color: COLORS.textMuted,
            padding: "10px 24px", borderRadius: 8, cursor: "pointer", fontSize: 14, transition: "all 0.2s",
          }}
            onMouseOver={e => { e.currentTarget.style.borderColor = COLORS.accent; e.currentTarget.style.color = COLORS.text; }}
            onMouseOut={e => { e.currentTarget.style.borderColor = COLORS.cardBorder; e.currentTarget.style.color = COLORS.textMuted; }}
          >
            Try with sample data →
          </button>

          {error && (
            <div style={{ marginTop: 20, padding: "12px 16px", background: COLORS.redMuted, border: `1px solid ${COLORS.red}`, borderRadius: 8, fontSize: 14, color: COLORS.red }}>
              {error}
            </div>
          )}

          <div style={{ marginTop: 40, fontSize: 12, color: COLORS.textDim, lineHeight: 1.8 }}>
            <strong style={{ color: COLORS.textMuted }}>Your data stays in your browser.</strong><br />
            Nothing is uploaded to any server. All analysis runs locally.
          </div>
        </div>
      </div>
    );
  }

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "tickers", label: "By Ticker" },
    { id: "timing", label: "Timing" },
    { id: "trades", label: "Trade Log" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: COLORS.bg, color: COLORS.text, fontFamily: "'Inter', -apple-system, sans-serif", padding: "20px 20px 40px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: COLORS.accent, textTransform: "uppercase", letterSpacing: 2 }}>Trade Analyzer</div>
          <div style={{ fontSize: 13, color: COLORS.textDim, marginTop: 2 }}>
            {fileName} {isDemo && <span style={{ color: COLORS.amber }}>(demo data)</span>} — {analytics.totalTrades} round-trip trades
          </div>
        </div>
        <label style={{
          fontSize: 13, color: COLORS.textMuted, cursor: "pointer", padding: "6px 14px",
          border: `1px solid ${COLORS.cardBorder}`, borderRadius: 6, background: COLORS.card,
        }}>
          <input type="file" accept=".csv" onChange={handleFileUpload} style={{ display: "none" }} />
          Upload New File
        </label>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 24, background: COLORS.card, borderRadius: 10, padding: 4, width: "fit-content" }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
            padding: "8px 18px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 500,
            background: activeTab === t.id ? COLORS.accent : "transparent",
            color: activeTab === t.id ? "#fff" : COLORS.textMuted,
            transition: "all 0.15s",
          }}>{t.label}</button>
        ))}
      </div>

      {/* Overview Tab */}
      {activeTab === "overview" && (
        <div>
          {/* Key Metrics */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 24 }}>
            <StatCard label="Total P&L" value={fmtUsd(analytics.totalPnl)} color={analytics.totalPnl >= 0 ? COLORS.green : COLORS.red} />
            <StatCard label="Win Rate" value={fmt(analytics.winRate, 1) + "%"} subtext={`${analytics.wins}W / ${analytics.losses}L`} color={analytics.winRate >= 50 ? COLORS.green : COLORS.red} />
            <StatCard label="Profit Factor" value={fmt(analytics.profitFactor, 2)} color={analytics.profitFactor >= 1.5 ? COLORS.green : analytics.profitFactor >= 1 ? COLORS.amber : COLORS.red} subtext={analytics.profitFactor >= 1.5 ? "Solid" : analytics.profitFactor >= 1 ? "Marginal" : "Negative edge"} />
            <StatCard label="Expectancy" value={fmtUsd(analytics.expectancy)} subtext="Avg $ per trade" color={analytics.expectancy >= 0 ? COLORS.green : COLORS.red} />
            <StatCard label="Avg Win" value={fmtUsd(analytics.avgWin)} color={COLORS.green} />
            <StatCard label="Avg Loss" value={fmtUsd(-analytics.avgLoss)} color={COLORS.red} />
            <StatCard label="Max Drawdown" value={fmtUsd(analytics.maxDrawdown)} color={COLORS.red} />
            <StatCard label="Streaks" value={`${analytics.maxWinStreak}W / ${analytics.maxLossStreak}L`} subtext="Max consecutive" />
          </div>

          {/* Cumulative P&L Chart */}
          <div style={{ background: COLORS.card, border: `1px solid ${COLORS.cardBorder}`, borderRadius: 12, padding: "20px 16px", marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>Cumulative P&L</div>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={analytics.cumPnl}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="date" tick={{ fill: COLORS.textDim, fontSize: 11 }} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fill: COLORS.textDim, fontSize: 11 }} tickLine={false} tickFormatter={v => "$" + (v / 1000).toFixed(1) + "k"} />
                <Tooltip content={<ChartTooltip formatter={fmtUsd} />} />
                <Line type="monotone" dataKey="pnl" stroke={COLORS.accent} strokeWidth={2} dot={false} name="Cumulative P&L" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Equity vs Options Split */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            <div style={{ background: COLORS.card, border: `1px solid ${COLORS.cardBorder}`, borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Equity vs Options</div>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={[
                    { name: "Equities", value: Math.abs(analytics.equityPnl), actual: analytics.equityPnl, count: analytics.equityCount },
                    { name: "Options", value: Math.abs(analytics.optionPnl), actual: analytics.optionPnl, count: analytics.optionCount },
                  ]} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value">
                    <Cell fill={COLORS.blue} />
                    <Cell fill={COLORS.purple} />
                  </Pie>
                  <Tooltip formatter={(v, name, props) => fmtUsd(props.payload.actual)} />
                  <Legend formatter={(value, entry) => <span style={{ color: COLORS.textMuted, fontSize: 12 }}>{value}</span>} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div style={{ background: COLORS.card, border: `1px solid ${COLORS.cardBorder}`, borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Monthly P&L</div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={analytics.monthlyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="month" tick={{ fill: COLORS.textDim, fontSize: 10 }} tickLine={false} />
                  <YAxis tick={{ fill: COLORS.textDim, fontSize: 10 }} tickLine={false} />
                  <Tooltip content={<ChartTooltip formatter={fmtUsd} />} />
                  <Bar dataKey="pnl" name="P&L" radius={[4, 4, 0, 0]}>
                    {analytics.monthlyData.map((d, i) => (
                      <Cell key={i} fill={d.pnl >= 0 ? COLORS.green : COLORS.red} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Hold time analysis */}
          <div style={{ background: COLORS.card, border: `1px solid ${COLORS.cardBorder}`, borderRadius: 12, padding: "16px 20px", marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Hold Time Insight</div>
            <div style={{ fontSize: 13, color: COLORS.textMuted, lineHeight: 1.7 }}>
              Your winners are held <strong style={{ color: COLORS.green }}>{fmt(analytics.avgHoldWin, 0)} days</strong> on average.
              Your losers are held <strong style={{ color: COLORS.red }}>{fmt(analytics.avgHoldLoss, 0)} days</strong> on average.
              {analytics.avgHoldLoss > analytics.avgHoldWin * 1.3 && (
                <span style={{ color: COLORS.amber }}> ⚠️ You're holding losers longer than winners — classic loss aversion pattern.</span>
              )}
              {analytics.avgHoldWin > analytics.avgHoldLoss * 1.3 && (
                <span style={{ color: COLORS.green }}> ✓ Good — you're letting winners run longer than losers.</span>
              )}
            </div>
          </div>

          {/* Top wins and losses */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={{ background: COLORS.card, border: `1px solid ${COLORS.cardBorder}`, borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: COLORS.green }}>Top 5 Winners</div>
              {analytics.topWins.map((t, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${COLORS.cardBorder}`, fontSize: 13 }}>
                  <span>{t.ticker} <span style={{ color: COLORS.textDim }}>({t.type})</span></span>
                  <span style={{ color: COLORS.green, fontFamily: "monospace" }}>{fmtUsd(t.pnl)}</span>
                </div>
              ))}
            </div>
            <div style={{ background: COLORS.card, border: `1px solid ${COLORS.cardBorder}`, borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: COLORS.red }}>Top 5 Losers</div>
              {analytics.topLosses.map((t, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${COLORS.cardBorder}`, fontSize: 13 }}>
                  <span>{t.ticker} <span style={{ color: COLORS.textDim }}>({t.type})</span></span>
                  <span style={{ color: COLORS.red, fontFamily: "monospace" }}>{fmtUsd(t.pnl)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tickers Tab */}
      {activeTab === "tickers" && (
        <div>
          <div style={{ background: COLORS.card, border: `1px solid ${COLORS.cardBorder}`, borderRadius: 12, padding: "20px 16px", marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>P&L by Ticker</div>
            <ResponsiveContainer width="100%" height={Math.max(300, analytics.tickerData.length * 36)}>
              <BarChart data={analytics.tickerData} layout="vertical" margin={{ left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false} />
                <XAxis type="number" tick={{ fill: COLORS.textDim, fontSize: 11 }} tickFormatter={v => "$" + v.toLocaleString()} />
                <YAxis type="category" dataKey="ticker" tick={{ fill: COLORS.text, fontSize: 12 }} width={60} />
                <Tooltip content={<ChartTooltip formatter={fmtUsd} />} />
                <Bar dataKey="pnl" name="P&L" radius={[0, 4, 4, 0]}>
                  {analytics.tickerData.map((d, i) => (
                    <Cell key={i} fill={d.pnl >= 0 ? COLORS.green : COLORS.red} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div style={{ background: COLORS.card, border: `1px solid ${COLORS.cardBorder}`, borderRadius: 12, padding: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Ticker Breakdown</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${COLORS.cardBorder}` }}>
                    {["Ticker", "Trades", "Win Rate", "P&L", "Avg P&L"].map(h => (
                      <th key={h} style={{ textAlign: "left", padding: "8px 12px", color: COLORS.textDim, fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {analytics.tickerData.map(t => (
                    <tr key={t.ticker} style={{ borderBottom: `1px solid ${COLORS.cardBorder}10` }}>
                      <td style={{ padding: "8px 12px", fontWeight: 600 }}>{t.ticker}</td>
                      <td style={{ padding: "8px 12px" }}>{t.count}</td>
                      <td style={{ padding: "8px 12px", color: (t.wins / t.count) * 100 >= 50 ? COLORS.green : COLORS.red }}>
                        {fmt((t.wins / t.count) * 100, 0)}%
                      </td>
                      <td style={{ padding: "8px 12px", color: t.pnl >= 0 ? COLORS.green : COLORS.red, fontFamily: "monospace" }}>{fmtUsd(t.pnl)}</td>
                      <td style={{ padding: "8px 12px", color: t.pnl / t.count >= 0 ? COLORS.green : COLORS.red, fontFamily: "monospace" }}>{fmtUsd(t.pnl / t.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Timing Tab */}
      {activeTab === "timing" && (
        <div>
          <div style={{ background: COLORS.card, border: `1px solid ${COLORS.cardBorder}`, borderRadius: 12, padding: "20px 16px", marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>Hold Time vs P&L</div>
            <ResponsiveContainer width="100%" height={300}>
              <ScatterChart>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="holdDays" name="Hold Days" tick={{ fill: COLORS.textDim, fontSize: 11 }} label={{ value: "Hold Days", fill: COLORS.textDim, fontSize: 12, position: "bottom" }} />
                <YAxis dataKey="pnl" name="P&L" tick={{ fill: COLORS.textDim, fontSize: 11 }} tickFormatter={v => "$" + v.toLocaleString()} />
                <Tooltip content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0]?.payload;
                  return (
                    <div style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", fontSize: 13 }}>
                      <div style={{ color: COLORS.text, fontWeight: 600 }}>{d?.ticker} ({d?.type})</div>
                      <div style={{ color: COLORS.textMuted }}>Hold: {d?.holdDays} days</div>
                      <div style={{ color: d?.pnl >= 0 ? COLORS.green : COLORS.red }}>P&L: {fmtUsd(d?.pnl)}</div>
                    </div>
                  );
                }} />
                <Scatter data={analytics.holdScatter.filter(d => d.type === "Equity")} fill={COLORS.blue} name="Equities" opacity={0.7} />
                <Scatter data={analytics.holdScatter.filter(d => d.type === "Option")} fill={COLORS.purple} name="Options" opacity={0.7} />
                <Legend formatter={(value) => <span style={{ color: COLORS.textMuted, fontSize: 12 }}>{value}</span>} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>

          <div style={{ background: COLORS.card, border: `1px solid ${COLORS.cardBorder}`, borderRadius: 12, padding: "20px 16px" }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>Monthly Performance</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${COLORS.cardBorder}` }}>
                    {["Month", "Trades", "Win Rate", "P&L"].map(h => (
                      <th key={h} style={{ textAlign: "left", padding: "8px 12px", color: COLORS.textDim, fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {analytics.monthlyData.map(m => (
                    <tr key={m.month} style={{ borderBottom: `1px solid ${COLORS.cardBorder}10` }}>
                      <td style={{ padding: "8px 12px", fontWeight: 600 }}>{m.month}</td>
                      <td style={{ padding: "8px 12px" }}>{m.count}</td>
                      <td style={{ padding: "8px 12px", color: (m.wins / m.count) * 100 >= 50 ? COLORS.green : COLORS.red }}>
                        {fmt((m.wins / m.count) * 100, 0)}%
                      </td>
                      <td style={{ padding: "8px 12px", color: m.pnl >= 0 ? COLORS.green : COLORS.red, fontFamily: "monospace" }}>{fmtUsd(m.pnl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Trade Log Tab */}
      {activeTab === "trades" && (
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.cardBorder}`, borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>All Round-Trip Trades ({roundTrips.length})</div>
          <div style={{ overflowX: "auto", maxHeight: 600, overflowY: "auto" }}>
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
              <thead style={{ position: "sticky", top: 0, background: COLORS.card }}>
                <tr style={{ borderBottom: `1px solid ${COLORS.cardBorder}` }}>
                  {["Exit Date", "Ticker", "Type", "Hold", "P&L", "P&L %"].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: "8px 10px", color: COLORS.textDim, fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...roundTrips].sort((a, b) => b.exitDate - a.exitDate).map((t, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${COLORS.cardBorder}10` }}>
                    <td style={{ padding: "6px 10px" }}>{t.exitDateStr}</td>
                    <td style={{ padding: "6px 10px", fontWeight: 600 }}>{t.ticker}</td>
                    <td style={{ padding: "6px 10px", color: t.type === "Option" ? COLORS.purple : COLORS.blue }}>{t.type}</td>
                    <td style={{ padding: "6px 10px" }}>{t.holdDays}d</td>
                    <td style={{ padding: "6px 10px", color: t.pnl >= 0 ? COLORS.green : COLORS.red, fontFamily: "monospace" }}>{fmtUsd(t.pnl)}</td>
                    <td style={{ padding: "6px 10px", color: t.pnlPct >= 0 ? COLORS.green : COLORS.red, fontFamily: "monospace" }}>{fmtPct(t.pnlPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{ marginTop: 24, fontSize: 11, color: COLORS.textDim, textAlign: "center" }}>
        All analysis runs in your browser. No data is sent to any server. Not financial advice.
      </div>
    </div>
  );
}