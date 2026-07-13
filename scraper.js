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
  console.log('正在從台灣銀行下載匯率資料...');
  const response = await fetch(BOT_CSV_URL);
  if (!response.ok) {
    throw new Error(`無法下載台銀匯率資料，狀態碼: ${response.status}`);
  }
  
  const csvText = await response.text();
  const lines = csvText.split('\n');
  
  let cnyData = null;
  
  // 尋找人民幣 (CNY) 的資料列
  for (const line of lines) {
    const cols = line.split(',');
    if (cols.length > 0 && cols[0].trim() === 'CNY') {
      cnyData = cols;
      break;
    }
  }
  
  if (!cnyData) {
    throw new Error('在台銀匯率資料中找不到人民幣 (CNY) 資料');
  }
  
  // 索引 2: 現金買入 (買進), 索引 12: 現金賣出
  const buyRate = parseFloat(cnyData[2]);
  const sellRate = parseFloat(cnyData[12]);
  
  if (isNaN(buyRate) || isNaN(sellRate)) {
    throw new Error(`解析匯率數值失敗: buy_rate=${cnyData[2]}, sell_rate=${cnyData[12]}`);
  }
  
  // 計算平均匯率，四捨五入至小數第二位
  const averageRate = Math.round(((buyRate + sellRate) / 2) * 100) / 100;
  
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
