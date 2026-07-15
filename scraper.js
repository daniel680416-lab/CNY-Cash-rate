import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';

// 臺灣銀行牌告匯率 CSV 網址
const BOT_CSV_URL = 'https://rate.bot.com.tw/xrt/flcsv/0/day';

// 取得台灣時間資訊
function getTaipeiTimeInfo() {
  const now = new Date();
  
  // 取得台灣日期 YYYY-MM-DD
  const dateParts = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  
  const year = dateParts.find(p => p.type === 'year').value;
  const month = dateParts.find(p => p.type === 'month').value;
  const day = dateParts.find(p => p.type === 'day').value;
  const dateStr = `${year}-${month}-${day}`;

  // 取得台灣時間 HH:MM
  const timeStr = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(now);

  return {
    dateStr,
    timeStr,
    timestamp: now.getTime(),
    now
  };
}

async function fetchRates() {
  const gasProxyUrl = process.env.GAS_PROXY_URL;
  if (gasProxyUrl) {
    console.log(`[Scraper] 偵測到 Google Apps Script 轉接站，嘗試透過轉接站獲取 100% 同步匯率...`);
    try {
      const response = await fetch(gasProxyUrl);
      if (response.ok) {
        const csvText = await response.text();
        const csvRates = parseCsvRates(csvText);
        if (csvRates) {
          console.log(`🎉 [Scraper] 成功透過 Google Apps Script 轉接站獲取台銀官方匯率: 現金買進=${csvRates.buyRate}, 現金賣出=${csvRates.sellRate}, 平均值=${csvRates.averageRate}`);
          return csvRates;
        }
      }
      console.warn('[Scraper] 透過 Google Apps Script 轉接站獲取失敗，降級使用直連/FinMind...');
    } catch (error) {
      console.warn(`[Scraper] Google Apps Script 轉接失敗: ${error.message}，降級使用直連/FinMind...`);
    }
  }

  console.log('正在從台灣銀行下載即時匯率資料...');
  try {
    const response = await fetch(BOT_CSV_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });

    if (response.ok) {
      const csvText = await response.text();
      const csvRates = parseCsvRates(csvText);
      if (csvRates) {
        console.log(`🎉 成功從台銀直連獲取最新匯率: 現金買進=${csvRates.buyRate}, 現金賣出=${csvRates.sellRate}, 平均值=${csvRates.averageRate}`);
        return csvRates;
      }
    }
    console.warn('無法從台銀直連獲取 CSV（可能遭遇 Challenge 阻擋），準備啟用備用資料源 (FinMind)...');
  } catch (error) {
    console.warn(`台銀直連連線失敗: ${error.message}，準備啟用備用資料源 (FinMind)...`);
  }

  // 備用資料源: FinMind API
  return await fetchFromFinMind();
}

function parseCsvRates(csvText) {
  const lines = csvText.split('\n');
  let cnyData = null;
  for (const line of lines) {
    const cols = line.split(',');
    if (cols.length > 0 && cols[0].trim() === 'CNY') {
      cnyData = cols;
      break;
    }
  }
  if (cnyData) {
    const buyRate = parseFloat(cnyData[2]);
    const sellRate = parseFloat(cnyData[12]);
    if (!isNaN(buyRate) && !isNaN(sellRate)) {
      const averageRate = Math.round(((buyRate + sellRate) / 2) * 100) / 100;
      return { buyRate, sellRate, averageRate };
    }
  }
  return null;
}

async function fetchFromFinMind() {
  const now = new Date();
  // 獲取前 5 天的日期，確保 API 能傳回足夠的資料來抓取最新一筆
  const pastDate = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const finmindUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanExchangeRate&data_id=CNY&start_date=${pastDate}`;

  console.log(`正在從備用資料源 (FinMind API) 下載匯率... URL: ${finmindUrl}`);
  const response = await fetch(finmindUrl);
  if (!response.ok) {
    throw new Error(`FinMind API 請求失敗，狀態碼: ${response.status}`);
  }

  const result = await response.json();
  if (!result || !result.data || result.data.length === 0) {
    throw new Error('FinMind API 未傳回任何匯率資料');
  }

  // 取得最新一筆的匯率紀錄 (最後一項)
  const latest = result.data[result.data.length - 1];
  const buyRate = parseFloat(latest.cash_buy);
  const sellRate = parseFloat(latest.cash_sell);

  if (isNaN(buyRate) || isNaN(sellRate)) {
    throw new Error(`FinMind 匯率解析失敗: cash_buy=${latest.cash_buy}, cash_sell=${latest.cash_sell}`);
  }

  const averageRate = Math.round(((buyRate + sellRate) / 2) * 100) / 100;
  console.log(`🎉 成功從 FinMind API 獲取最新匯率 (${latest.date}): 現金買進=${buyRate}, 現金賣出=${sellRate}, 平均值=${averageRate}`);

  return {
    buyRate,
    sellRate,
    averageRate
  };
}

async function syncAndExport(rates) {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('未設定環境變數 MONGODB_URI');
  }

  const { dateStr, timeStr, timestamp, now } = getTaipeiTimeInfo();
  const client = new MongoClient(uri);

  try {
    console.log('正在連線至 MongoDB Atlas...');
    await client.connect();
    
    const db = client.db('exchange_rates');
    const collection = db.collection('cny_cash_rates');
    
    // 確保建立 date 唯一索引
    console.log('確保建立 date 唯一索引...');
    await collection.createIndex({ date: 1 }, { unique: true });
    
    const document = {
      date: dateStr,
      last_updated_time: timeStr,
      timestamp: timestamp,
      buy_rate: rates.buyRate,
      sell_rate: rates.sellRate,
      average_rate: rates.averageRate,
      updated_at: now,
      source: 'bot'
    };
    
    console.log(`準備寫入/更新匯率資料 (${dateStr} ${timeStr}):`, document);

    // 當日僅保留最後一筆，使用 upsert 寫入/更新
    await collection.updateOne(
      { date: dateStr },
      { 
        $set: document,
        $setOnInsert: { created_at: now }
      },
      { upsert: true }
    );
    console.log('當日資料 Upsert 寫入成功！');

    // 撈取近 30 天的歷史匯率紀錄 (依日期降序)
    console.log('正在從 MongoDB 撈取近 30 天歷史數據...');
    const history = await collection
      .find({})
      .sort({ date: -1 })
      .limit(30)
      .toArray();

    // 格式化輸出資料
    const formattedHistory = history.map(item => ({
      date: item.date,
      buy_rate: item.buy_rate,
      sell_rate: item.sell_rate,
      average_rate: item.average_rate,
      timestamp: item.timestamp,
      last_updated_time: item.last_updated_time,
      source: item.source || 'bot'
    }));

    // 輸出成 data.json 靜態檔案到根目錄下
    const outputPath = path.join(process.cwd(), 'data.json');
    fs.writeFileSync(outputPath, JSON.stringify(formattedHistory, null, 2), 'utf-8');
    console.log(`成功匯出近 30 天歷史匯率至: ${outputPath}`);

  } finally {
    await client.close();
    console.log('MongoDB 連線已關閉。');
  }
}

async function main() {
  try {
    const rates = await fetchRates();
    console.log(`成功解析台銀最新匯率: 現金買進=${rates.buyRate}, 現金賣出=${rates.sellRate}, 平均值=${rates.averageRate}`);
    await syncAndExport(rates);
    console.log('匯率爬取、資料庫同步與 data.json 導出作業已全部順利完成！');
  } catch (error) {
    console.error('執行過程中發生致命錯誤:', error.message);
    process.exit(1);
  }
}

main();
