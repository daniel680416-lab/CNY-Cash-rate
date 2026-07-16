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
    const BOT_HTML_URL = "https://rate.bot.com.tw/xrt?Lang=zh-TW";
    const scraperUrl = `https://api.scraperapi.com/?api_key=${scraperApiKey}&url=${encodeURIComponent(BOT_CSV_URL)}`;
    const htmlScraperUrl = `https://api.scraperapi.com/?api_key=${scraperApiKey}&url=${encodeURIComponent(BOT_HTML_URL)}&render=true`;

    try {
      let buyRate, sellRate;
      let response = await fetch(scraperUrl);
      let text = await response.text();

      // 偵測是否被台銀 WAF 阻擋 (回傳 Challenge Validation 網頁)
      if (!response.ok || text.includes("Challenge Validation") || text.includes("<html") || text.includes("<!DOCTYPE")) {
        console.log("步驟 1 失敗（遭 WAF 阻擋或非 CSV），嘗試步驟 2: 透過 ScraperAPI 渲染 HTML...");
        response = await fetch(htmlScraperUrl);
        if (!response.ok) {
          throw new Error(`ScraperAPI HTML 渲染失敗，狀態碼: ${response.status}`);
        }
        text = await response.text();

        // 優先使用精確屬性匹配正則
        let match = text.match(/人民幣\s*\(CNY\)[\s\S]*?data-table="本行現金買入"[^>]*>([\d.]+)<\/td>[\s\S]*?data-table="本行現金賣出"[^>]*>([\d.]+)<\/td>/i);
        if (!match) {
          // 降級使用寬鬆正則
          match = text.match(/人民幣\s*\(CNY\)[\s\S]*?>([\d.]+)<\/td>[\s\S]*?>([\d.]+)<\/td>/i);
        }

        if (match) {
          buyRate = parseFloat(match[1]);
          sellRate = parseFloat(match[2]);
        } else {
          throw new Error(`HTML 內容中未找到人民幣匯率欄位！收到的內容前 300 字元為: "${text.substring(0, 300).replace(/\r?\n/g, ' ')}"`);
        }
      } else {
        // 解析 CSV
        const lines = text.split(/\r?\n/);
        let cnyData = null;
        for (const line of lines) {
          const cols = line.split(",");
          if (cols.length > 0 && cols[0].trim() === "CNY") {
            cnyData = cols;
            break;
          }
        }

        if (!cnyData) {
          throw new Error(`CSV 資料中未找到人民幣 (CNY) 欄位！收到的內容前 300 字元為: "${text.substring(0, 300).replace(/\r?\n/g, ' ')}"`);
        }

        buyRate = parseFloat(cnyData[2]); // 現金買入
        sellRate = parseFloat(cnyData[12]); // 現金賣出
      }

      if (isNaN(buyRate) || isNaN(sellRate)) {
        throw new Error("匯率解析數值錯誤，非有效數字！");
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
