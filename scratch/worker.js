export default {
  async fetch(request, env) {
    // 啟用 CORS 跨網域存取
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const scraperApiKey = env.SCRAPER_API_KEY;
    if (!scraperApiKey) {
      return new Response(JSON.stringify({ error: "Cloudflare Worker 尚未配置 SCRAPER_API_KEY 環境變數！" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    const BOT_CSV_URL = "https://rate.bot.com.tw/xrt/flcsv/0/day";
    const scraperUrl = `https://api.scraperapi.com/?api_key=${scraperApiKey}&url=${encodeURIComponent(BOT_CSV_URL)}`;

    try {
      let response = await fetch(scraperUrl);
      if (!response.ok) {
        throw new Error(`ScraperAPI 回傳錯誤，狀態碼: ${response.status}`);
      }

      let csvText = await response.text();

      // 偵測是否被台銀 WAF 阻擋 (回傳 Challenge Validation 網頁)
      if (csvText.includes("Challenge Validation") || csvText.includes("<html") || csvText.includes("<!DOCTYPE")) {
        console.log("偵測到台銀 WAF 阻擋，嘗試啟用 ScraperAPI Premium 住宅代理...");
        const premiumUrl = `${scraperUrl}&premium=true`;
        response = await fetch(premiumUrl);
        if (!response.ok) {
          throw new Error(`ScraperAPI Premium 住宅代理回傳錯誤，狀態碼: ${response.status}`);
        }
        csvText = await response.text();
      }
      
      // 解析 CSV，擷取 CNY 資料行
      const lines = csvText.split("\n");
      let cnyData = null;
      for (const line of lines) {
        const cols = line.split(",");
        if (cols.length > 0 && cols[0].trim() === "CNY") {
          cnyData = cols;
          break;
        }
      }

      if (!cnyData) {
        throw new Error(`CSV 資料中未找到人民幣 (CNY) 欄位！收到的內容前 300 字元為: "${csvText.substring(0, 300).replace(/\r?\n/g, ' ')}"`);
      }

      const buyRate = parseFloat(cnyData[2]); // 現金買入
      const sellRate = parseFloat(cnyData[12]); // 現金賣出
      if (isNaN(buyRate) || isNaN(sellRate)) {
        throw new Error("CSV 欄位數值解析錯誤，非有效數字！");
      }

      const avgRate = Math.round(((buyRate + sellRate) / 2) * 100) / 100;
      
      // 取得台北時間今天的日期 (YYYY-MM-DD) 與時間 (HH:MM)
      const formatter = new Intl.DateTimeFormat("zh-TW", {
        timeZone: "Asia/Taipei",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      });
      const parts = formatter.formatToParts(new Date());
      const year = parts.find(p => p.type === "year").value;
      const month = parts.find(p => p.type === "month").value;
      const day = parts.find(p => p.type === "day").value;
      const dateStr = `${year}-${month}-${day}`;

      const timeFormatter = new Intl.DateTimeFormat("zh-TW", {
        timeZone: "Asia/Taipei",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      });
      const timeStr = timeFormatter.format(new Date());

      const data = {
        date: dateStr,
        buy_rate: buyRate,
        sell_rate: sellRate,
        average_rate: avgRate,
        timestamp: Date.now(),
        last_updated_time: timeStr,
        source: "bot"
      };

      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }
}
