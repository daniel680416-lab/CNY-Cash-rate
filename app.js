// ==========================================
// CNY Rate Tracker PWA Frontend Application
// 支援台灣銀行「現金匯率」與「即期匯率」即時同步追蹤
// ==========================================

// --- MOCK DATA (Fallback if network is down and cache is empty) ---
const MOCK_HISTORICAL_DATA = [
  { date: "2026-10-13", buy_rate: 4.693, sell_rate: 4.855, average_rate: 4.77, spot_buy_rate: 4.765, spot_sell_rate: 4.815, spot_average_rate: 4.79, timestamp: 1791869382914, last_updated_time: "13:29", source: "bot" },
  { date: "2026-10-12", buy_rate: 4.670, sell_rate: 4.832, average_rate: 4.75, spot_buy_rate: 4.742, spot_sell_rate: 4.792, spot_average_rate: 4.77, timestamp: 1791782400000, last_updated_time: "16:00", source: "bot" },
  { date: "2026-10-08", buy_rate: 4.661, sell_rate: 4.823, average_rate: 4.74, spot_buy_rate: 4.733, spot_sell_rate: 4.783, spot_average_rate: 4.76, timestamp: 1791436800000, last_updated_time: "16:00", source: "bot" },
  { date: "2026-10-07", buy_rate: 4.655, sell_rate: 4.817, average_rate: 4.74, spot_buy_rate: 4.727, spot_sell_rate: 4.777, spot_average_rate: 4.75, timestamp: 1791350400000, last_updated_time: "16:00", source: "bot" },
  { date: "2026-10-06", buy_rate: 4.660, sell_rate: 4.822, average_rate: 4.74, spot_buy_rate: 4.732, spot_sell_rate: 4.782, spot_average_rate: 4.76, timestamp: 1791264000000, last_updated_time: "16:00", source: "bot" },
  { date: "2026-10-05", buy_rate: 4.665, sell_rate: 4.827, average_rate: 4.75, spot_buy_rate: 4.737, spot_sell_rate: 4.787, spot_average_rate: 4.76, timestamp: 1791177600000, last_updated_time: "16:00", source: "bot" },
  { date: "2026-10-02", buy_rate: 4.668, sell_rate: 4.830, average_rate: 4.75, spot_buy_rate: 4.740, spot_sell_rate: 4.790, spot_average_rate: 4.76, timestamp: 1790918400000, last_updated_time: "16:00", source: "bot" }
];

// --- CONFIGURATION ---
// Cloudflare Worker 網址以實現前端盤中即時同步
const CLOUDFLARE_WORKER_URL = 'https://scratch.daniel680416.workers.dev/'; 

// --- APP STATE ---
let currentRates = []; // Loaded exchange rate data (Sorted by date desc)
let mainChartInstance = null;
let sparklineChartInstance = null;
let activeDashboardMode = 'cash'; // 'cash', 'spot', 'all'
let activeTrendRateType = 'cash'; // 'cash', 'spot', 'compare'
let activeTrendDays = 7;
let activeCalcMode = 'cash_sell'; // 'cash_sell', 'spot_sell', 'cash_buy', 'spot_buy', 'avg'
let alertSettings = { low: null, high: null };
let isRefreshing = false;

// --- INDEXED DB HELPER ---
function openIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('CNYRateTrackerDB', 2);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('rates')) {
        db.createObjectStore('rates', { keyPath: 'date' });
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function getCachedRates() {
  try {
    const db = await openIndexedDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('rates', 'readonly');
      const store = tx.objectStore('rates');
      const req = store.getAll();
      req.onsuccess = () => {
        const sorted = req.result.sort((a, b) => b.timestamp - a.timestamp);
        resolve(sorted);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    console.error('讀取 IndexedDB 快取失敗:', error);
    return [];
  }
}

async function cacheRates(ratesArray) {
  try {
    const db = await openIndexedDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('rates', 'readwrite');
      const store = tx.objectStore('rates');
      ratesArray.forEach(rate => store.put(rate));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.error('寫入 IndexedDB 快取失敗:', error);
  }
}

async function clearIndexedDBCache() {
  try {
    const db = await openIndexedDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('rates', 'readwrite');
      const store = tx.objectStore('rates');
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    console.error('清除 IndexedDB 快取失敗:', error);
  }
}

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
  // 註冊 PWA Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then(reg => console.log('Service Worker 註冊成功，範圍:', reg.scope))
        .catch(err => console.error('Service Worker 註冊失敗:', err));
    });
  }

  // Initialize Lucide Icons
  lucide.createIcons();

  // Load Settings from LocalStorage
  loadSettings();

  // Setup Event Listeners
  setupNavigation();
  setupDashboardControls();
  setupTrendControls();
  setupTheme();
  setupNetworkMonitoring();
  setupSettingsHandlers();
  setupCalculator();
  setupPwaInstall();
  setupRefreshButton();
  setupAutoRefresh();

  // Load Data
  refreshData();
});

// --- DATA FETCHING & SYNCHRONIZATION ---
function loadSettings() {
  const savedAlertSettings = localStorage.getItem('cny_tracker_alert_settings');
  if (savedAlertSettings) {
    alertSettings = JSON.parse(savedAlertSettings);
    const lowInput = document.getElementById('alert-low');
    const highInput = document.getElementById('alert-high');
    if (lowInput) lowInput.value = alertSettings.low || '';
    if (highInput) highInput.value = alertSettings.high || '';
  }
}

// 核心資料更新函式
async function refreshData(isManualTrigger = false) {
  if (isRefreshing) return;
  isRefreshing = true;

  const refreshBtn = document.getElementById('refreshBtn');
  const refreshIcon = refreshBtn ? refreshBtn.querySelector('i') : null;
  if (refreshIcon) refreshIcon.classList.add('spinning');

  const isOnline = navigator.onLine;
  let fetchedData = [];

  if (isOnline) {
    const tbody = document.getElementById('historyTableBody');
    if (tbody && currentRates.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="table-loading">正在下載最新匯率數據...</td></tr>';
    }

    try {
      // 1. 先抓取伺服器 static data.json (防瀏覽器快取)
      fetchedData = await fetchRatesData();

      // 2. 進行即時同步補充（檢查盤中官方即時匯率）
      fetchedData = await supplementLiveRates(fetchedData);

      if (fetchedData && fetchedData.length > 0) {
        await cacheRates(fetchedData);
      }
    } catch (error) {
      console.error('線上獲取最新匯率失敗，嘗試讀取本地快取:', error);
      fetchedData = await getCachedRates();
      // 離線快取亦嘗試向 Live API 補充
      fetchedData = await supplementLiveRates(fetchedData);
    }
  } else {
    // 離線狀態
    fetchedData = await getCachedRates();
  }

  // 若快取與線上皆無資料，降級使用 MOCK DATA
  if (!fetchedData || fetchedData.length === 0) {
    console.log('未檢測到有效數據，載入預設模擬數據。');
    fetchedData = MOCK_HISTORICAL_DATA;
    await cacheRates(MOCK_HISTORICAL_DATA);
  }

  // 更新全域狀態
  currentRates = fetchedData;

  // 渲染所有 UI 元件
  updateDashboardUI();
  renderSparkline();
  updateCalculatorUI();
  updateHistoryTable();
  renderMainTrendChart(activeTrendDays);

  if (refreshIcon) {
    setTimeout(() => {
      refreshIcon.classList.remove('spinning');
      isRefreshing = false;
    }, 600);
  } else {
    isRefreshing = false;
  }

  if (isManualTrigger) {
    showToastNotification('🎉 匯率數據已即時同步更新完成！');
  }
}

// 透過 Cloudflare Worker 或備用 API 獲取盤中官方即時匯率
async function supplementLiveRates(data) {
  if (!data || data.length === 0) return data;

  // 取得台北時間今日日期 YYYY-MM-DD
  const todayStr = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date()).replace(/\//g, '-');

  // 1. 優先嘗試透過 Cloudflare Worker 即時抓取台銀官方牌告
  if (typeof CLOUDFLARE_WORKER_URL === 'string' && CLOUDFLARE_WORKER_URL.trim() !== '') {
    try {
      console.log(`[CNY Tracker] 正在呼叫 Cloudflare Worker 檢查今日 (${todayStr}) 盤中即時匯率...`);
      const workerUrl = `${CLOUDFLARE_WORKER_URL}?t=${Date.now()}`;
      const res = await fetch(workerUrl, { cache: 'no-store' });
      
      if (res.ok) {
        const liveRecord = await res.json();
        if (liveRecord && liveRecord.date === todayStr && liveRecord.buy_rate && liveRecord.sell_rate) {
          console.log('[CNY Tracker] 🎉 成功由 Cloudflare Worker 取得台銀即時匯率:', liveRecord);

          // 標註為盤中即時同步
          const standardizedRecord = {
            date: todayStr,
            buy_rate: liveRecord.buy_rate,
            sell_rate: liveRecord.sell_rate,
            average_rate: liveRecord.average_rate || Math.round(((liveRecord.buy_rate + liveRecord.sell_rate) / 2) * 100) / 100,
            spot_buy_rate: liveRecord.spot_buy_rate ?? (data[0] && data[0].date === todayStr ? data[0].spot_buy_rate : null),
            spot_sell_rate: liveRecord.spot_sell_rate ?? (data[0] && data[0].date === todayStr ? data[0].spot_sell_rate : null),
            spot_average_rate: liveRecord.spot_average_rate ?? (data[0] && data[0].date === todayStr ? data[0].spot_average_rate : null),
            timestamp: liveRecord.timestamp || Date.now(),
            last_updated_time: liveRecord.last_updated_time || new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()),
            source: 'bot_live'
          };

          // 若首筆紀錄就是今天，進行更新覆蓋
          if (data[0].date === todayStr) {
            const updated = [...data];
            updated[0] = standardizedRecord;
            return updated;
          } else {
            // 首筆紀錄不是今天（如今天剛開盤），將今日紀錄插至最前
            return [standardizedRecord, ...data];
          }
        }
      }
    } catch (err) {
      console.warn('[CNY Tracker] 透過 Cloudflare Worker 即時更新失敗:', err.message);
    }
  }

  // 2. 備用方案：若伺服器最新資料並非今日，嘗試向 FinMind 查詢今日資料
  if (data[0].date !== todayStr) {
    try {
      console.log('[CNY Tracker] 嘗試從備用資料源 (FinMind) 獲取今日數據...');
      const pastDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const finmindUrl = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanExchangeRate&data_id=CNY&start_date=${pastDate}`;
      const res = await fetch(finmindUrl);
      if (res.ok) {
        const result = await res.json();
        if (result && result.data && result.data.length > 0) {
          const latest = result.data[result.data.length - 1];
          if (latest.date === todayStr) {
            const buyRate = parseFloat(latest.cash_buy);
            const sellRate = parseFloat(latest.cash_sell);
            const spotBuy = parseFloat(latest.spot_buy);
            const spotSell = parseFloat(latest.spot_sell);

            if (!isNaN(buyRate) && !isNaN(sellRate)) {
              const avgRate = Math.round(((buyRate + sellRate) / 2) * 100) / 100;
              const validSpotBuy = !isNaN(spotBuy) ? spotBuy : null;
              const validSpotSell = !isNaN(spotSell) ? spotSell : null;
              const spotAvg = (validSpotBuy && validSpotSell) ? Math.round(((validSpotBuy + validSpotSell) / 2) * 100) / 100 : null;

              const todayRecord = {
                date: todayStr,
                buy_rate: buyRate,
                sell_rate: sellRate,
                average_rate: avgRate,
                spot_buy_rate: validSpotBuy,
                spot_sell_rate: validSpotSell,
                spot_average_rate: spotAvg,
                timestamp: Date.now(),
                last_updated_time: new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()),
                source: 'finmind_live'
              };
              console.log('[CNY Tracker] 🎉 成功由 FinMind 取得今日匯率:', todayRecord);
              return [todayRecord, ...data];
            }
          }
        }
      }
    } catch (err) {
      console.warn('[CNY Tracker] FinMind 備用獲取失敗:', err.message);
    }
  }

  return data;
}

// 讀取靜態 data.json (防瀏覽器強制快取)
async function fetchRatesData() {
  const response = await fetch(`./data.json?t=${Date.now()}`);
  if (!response.ok) {
    throw new Error(`無法獲取 data.json, 狀態碼: ${response.status}`);
  }
  return await response.json();
}

// --- UI UPDATES (DASHBOARD) ---
function updateDashboardUI() {
  if (currentRates.length === 0) return;

  const today = currentRates[0];
  const yesterday = currentRates.length > 1 ? currentRates[1] : null;

  // 1. 現金匯率數值
  document.getElementById('buyRateValue').textContent = today.buy_rate.toFixed(3);
  document.getElementById('sellRateValue').textContent = today.sell_rate.toFixed(3);
  document.getElementById('avgRateValue').textContent = today.average_rate.toFixed(2);

  // 2. 即期匯率數值
  const spotBuyEl = document.getElementById('spotBuyRateValue');
  const spotSellEl = document.getElementById('spotSellRateValue');
  const spotAvgEl = document.getElementById('spotAvgRateValue');

  if (spotBuyEl) spotBuyEl.textContent = today.spot_buy_rate ? today.spot_buy_rate.toFixed(3) : '--.--';
  if (spotSellEl) spotSellEl.textContent = today.spot_sell_rate ? today.spot_sell_rate.toFixed(3) : '--.--';
  if (spotAvgEl) spotAvgEl.textContent = today.spot_average_rate ? today.spot_average_rate.toFixed(2) : '--.--';

  // 3. 漲跌幅計算 (較昨日收盤)
  updateTrendIndicator('buyRateChange', today.buy_rate, yesterday ? yesterday.buy_rate : null);
  updateTrendIndicator('sellRateChange', today.sell_rate, yesterday ? yesterday.sell_rate : null);
  updateTrendIndicator('avgRateChange', today.average_rate, yesterday ? yesterday.average_rate : null);

  if (today.spot_buy_rate && yesterday && yesterday.spot_buy_rate) {
    updateTrendIndicator('spotBuyRateChange', today.spot_buy_rate, yesterday.spot_buy_rate);
  } else {
    resetTrendIndicator('spotBuyRateChange');
  }

  if (today.spot_sell_rate && yesterday && yesterday.spot_sell_rate) {
    updateTrendIndicator('spotSellRateChange', today.spot_sell_rate, yesterday.spot_sell_rate);
  } else {
    resetTrendIndicator('spotSellRateChange');
  }

  if (today.spot_average_rate && yesterday && yesterday.spot_average_rate) {
    updateTrendIndicator('spotAvgRateChange', today.spot_average_rate, yesterday.spot_average_rate);
  } else {
    resetTrendIndicator('spotAvgRateChange');
  }

  // 4. 更新標籤與資料來源
  let sourceLabel = '';
  if (today.source === 'bot_live') {
    sourceLabel = '台銀盤中即時連線 (Live)';
  } else if (today.source === 'bot') {
    sourceLabel = '台銀官方牌告';
  } else if (today.source === 'finmind_live') {
    sourceLabel = '備用源即時同步 (FinMind)';
  } else {
    sourceLabel = '台銀牌告匯率';
  }
  document.getElementById('lastUpdatedTime').textContent = `最後更新時間：${today.date} ${today.last_updated_time} (${sourceLabel})`;

  // 5. 價差分析 (即期 vs 現金)
  updateSpreadAnalysis(today);

  // 6. 依照 activeDashboardMode 切換卡片顯示
  applyDashboardModeView();

  // 7. 檢查警示閥值
  checkAlertThreshold(today.average_rate);
}

// 價差分析計算
function updateSpreadAnalysis(today) {
  const sellDiffEl = document.getElementById('spreadSellDiff');
  const buyDiffEl = document.getElementById('spreadBuyDiff');

  if (today.sell_rate && today.spot_sell_rate) {
    const diffSell = today.sell_rate - today.spot_sell_rate;
    const savePer10k = Math.round(diffSell * 10000);
    if (sellDiffEl) {
      sellDiffEl.innerHTML = `即期比現鈔<strong>便宜 ${diffSell.toFixed(3)} TWD</strong> (每結匯 1萬 CNY 省 NT$ ${savePer10k})`;
    }
  } else if (sellDiffEl) {
    sellDiffEl.textContent = '暫無即期賣出數據進行比對';
  }

  if (today.buy_rate && today.spot_buy_rate) {
    const diffBuy = today.spot_buy_rate - today.buy_rate;
    const gainPer10k = Math.round(diffBuy * 10000);
    if (buyDiffEl) {
      buyDiffEl.innerHTML = `即期比現鈔<strong>高出 ${diffBuy.toFixed(3)} TWD</strong> (外幣存回每 1萬 CNY 多拿 NT$ ${gainPer10k})`;
    }
  } else if (buyDiffEl) {
    buyDiffEl.textContent = '暫無即期買入數據進行比對';
  }
}

// 切換儀表板展示模式
function applyDashboardModeView() {
  const cashGrid = document.getElementById('cashCardsGrid');
  const spotGrid = document.getElementById('spotCardsGrid');
  const cashTitle = document.getElementById('cashSectionTitle');
  const spotTitle = document.getElementById('spotSectionTitle');
  const sparklineTitle = document.getElementById('sparklineTitle');

  if (activeDashboardMode === 'cash') {
    if (cashGrid) cashGrid.style.display = 'grid';
    if (spotGrid) spotGrid.style.display = 'none';
    if (cashTitle) cashTitle.style.display = 'none';
    if (spotTitle) spotTitle.style.display = 'none';
    if (sparklineTitle) sparklineTitle.textContent = '走勢簡介 (7日現金平均值)';
  } else if (activeDashboardMode === 'spot') {
    if (cashGrid) cashGrid.style.display = 'none';
    if (spotGrid) spotGrid.style.display = 'grid';
    if (cashTitle) cashTitle.style.display = 'none';
    if (spotTitle) spotTitle.style.display = 'none';
    if (sparklineTitle) sparklineTitle.textContent = '走勢簡介 (7日即期平均值)';
  } else {
    // 'all' 對照比較模式
    if (cashGrid) cashGrid.style.display = 'grid';
    if (spotGrid) spotGrid.style.display = 'grid';
    if (cashTitle) cashTitle.style.display = 'flex';
    if (spotTitle) spotTitle.style.display = 'flex';
    if (sparklineTitle) sparklineTitle.textContent = '走勢簡介 (7日綜合走勢)';
  }
}

function updateTrendIndicator(elementId, todayVal, yesterdayVal) {
  const el = document.getElementById(elementId);
  if (!el) return;

  if (!yesterdayVal) {
    el.textContent = '0.00%';
    el.className = 'change-label neutral';
    return;
  }

  const diff = todayVal - yesterdayVal;
  const pct = ((diff / yesterdayVal) * 100).toFixed(2);
  const prefix = diff > 0 ? '+' : '';

  el.textContent = `${prefix}${pct}%`;
  if (diff > 0) {
    el.className = 'change-label up';
  } else if (diff < 0) {
    el.className = 'change-label down';
  } else {
    el.className = 'change-label neutral';
  }
}

function resetTrendIndicator(elementId) {
  const el = document.getElementById(elementId);
  if (el) {
    el.textContent = '--%';
    el.className = 'change-label neutral';
  }
}

function checkAlertThreshold(avgRate) {
  const alertBanner = document.getElementById('thresholdAlertBanner');
  const alertText = document.getElementById('thresholdAlertText');
  if (!alertBanner || !alertText) return;

  let showAlert = false;
  let textMsg = '';

  if (alertSettings.low && avgRate <= alertSettings.low) {
    showAlert = true;
    textMsg = `【買點提示】當前平均匯率 (${avgRate.toFixed(2)}) 已低於您設定的目標下限 (${parseFloat(alertSettings.low).toFixed(2)})，是合適的換匯點！`;
  } else if (alertSettings.high && avgRate >= alertSettings.high) {
    showAlert = true;
    textMsg = `【賣點提示】當前平均匯率 (${avgRate.toFixed(2)}) 已高於您設定的目標上限 (${parseFloat(alertSettings.high).toFixed(2)})，是合適的結匯賣出點！`;
  }

  if (showAlert) {
    alertText.textContent = textMsg;
    alertBanner.classList.remove('hidden');
  } else {
    alertBanner.classList.add('hidden');
  }
}

// 儀表板切換按鈕事件
function setupDashboardControls() {
  const selector = document.getElementById('dashboardRateTypeSelector');
  if (!selector) return;

  const buttons = selector.querySelectorAll('button');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeDashboardMode = btn.getAttribute('data-mode');
      applyDashboardModeView();
      renderSparkline();
    });
  });
}

// --- CHARTS (SPARKLINE & MAIN TREND) ---
function renderSparkline() {
  const canvas = document.getElementById('sparklineChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (sparklineChartInstance) sparklineChartInstance.destroy();

  const last7Data = [...currentRates].slice(0, 7).reverse();
  if (last7Data.length === 0) return;

  const labels = last7Data.map(d => d.date.substring(5)); // MM-DD
  let chartValues = [];
  let lineColor = '#8b5cf6';
  let fillColor = 'rgba(139, 92, 246, 0.05)';

  if (activeDashboardMode === 'spot') {
    chartValues = last7Data.map(d => d.spot_average_rate || d.average_rate);
    lineColor = '#3b82f6';
    fillColor = 'rgba(59, 130, 246, 0.05)';
  } else {
    chartValues = last7Data.map(d => d.average_rate);
  }

  sparklineChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        data: chartValues,
        borderColor: lineColor,
        borderWidth: 2,
        fill: true,
        backgroundColor: fillColor,
        tension: 0.4,
        pointRadius: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: true } },
      scales: {
        x: { display: false },
        y: { display: false }
      }
    }
  });
}

function renderMainTrendChart(daysRange) {
  const canvas = document.getElementById('mainTrendChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (mainChartInstance) mainChartInstance.destroy();

  const chartData = [...currentRates].slice(0, daysRange).reverse();
  if (chartData.length === 0) return;

  const labels = chartData.map(d => d.date);
  const isLight = document.body.classList.contains('light-mode');
  const gridColor = isLight ? 'rgba(15, 23, 42, 0.05)' : 'rgba(255, 255, 255, 0.05)';
  const textColor = isLight ? '#475569' : '#94a3b8';

  let datasets = [];
  const legendCustom = document.getElementById('chartLegendCustom');

  if (activeTrendRateType === 'cash') {
    datasets = [
      {
        label: '現金買進',
        data: chartData.map(d => d.buy_rate),
        borderColor: '#10b981',
        backgroundColor: 'rgba(16, 185, 129, 0.05)',
        borderWidth: 2,
        tension: 0.35,
        pointBackgroundColor: '#10b981',
        pointRadius: 3
      },
      {
        label: '現金賣出',
        data: chartData.map(d => d.sell_rate),
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245, 158, 11, 0.05)',
        borderWidth: 2,
        tension: 0.35,
        pointBackgroundColor: '#f59e0b',
        pointRadius: 3
      },
      {
        label: '現金平均',
        data: chartData.map(d => d.average_rate),
        borderColor: '#8b5cf6',
        backgroundColor: 'rgba(139, 92, 246, 0.08)',
        borderWidth: 3,
        tension: 0.35,
        pointBackgroundColor: '#8b5cf6',
        pointRadius: 4,
        fill: true
      }
    ];

    if (legendCustom) {
      legendCustom.innerHTML = `
        <span class="legend-item"><span class="legend-color" style="background:#10b981;"></span>現金買進</span>
        <span class="legend-item"><span class="legend-color" style="background:#f59e0b;"></span>現金賣出</span>
        <span class="legend-item"><span class="legend-color" style="background:#8b5cf6;"></span>現金平均</span>
      `;
    }
  } else if (activeTrendRateType === 'spot') {
    datasets = [
      {
        label: '即期買入',
        data: chartData.map(d => d.spot_buy_rate || null),
        borderColor: '#06b6d4',
        backgroundColor: 'rgba(6, 182, 212, 0.05)',
        borderWidth: 2,
        tension: 0.35,
        pointBackgroundColor: '#06b6d4',
        pointRadius: 3
      },
      {
        label: '即期賣出',
        data: chartData.map(d => d.spot_sell_rate || null),
        borderColor: '#ec4899',
        backgroundColor: 'rgba(236, 72, 153, 0.05)',
        borderWidth: 2,
        tension: 0.35,
        pointBackgroundColor: '#ec4899',
        pointRadius: 3
      },
      {
        label: '即期平均',
        data: chartData.map(d => d.spot_average_rate || null),
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.08)',
        borderWidth: 3,
        tension: 0.35,
        pointBackgroundColor: '#3b82f6',
        pointRadius: 4,
        fill: true
      }
    ];

    if (legendCustom) {
      legendCustom.innerHTML = `
        <span class="legend-item"><span class="legend-color" style="background:#06b6d4;"></span>即期買入</span>
        <span class="legend-item"><span class="legend-color" style="background:#ec4899;"></span>即期賣出</span>
        <span class="legend-item"><span class="legend-color" style="background:#3b82f6;"></span>即期平均</span>
      `;
    }
  } else {
    // 'compare' 對比走勢
    datasets = [
      {
        label: '現金平均匯率',
        data: chartData.map(d => d.average_rate),
        borderColor: '#8b5cf6',
        borderWidth: 2.5,
        tension: 0.35,
        pointBackgroundColor: '#8b5cf6',
        pointRadius: 3
      },
      {
        label: '即期平均匯率',
        data: chartData.map(d => d.spot_average_rate || null),
        borderColor: '#3b82f6',
        borderWidth: 2.5,
        tension: 0.35,
        pointBackgroundColor: '#3b82f6',
        pointRadius: 3
      }
    ];

    if (legendCustom) {
      legendCustom.innerHTML = `
        <span class="legend-item"><span class="legend-color" style="background:#8b5cf6;"></span>現金平均匯率</span>
        <span class="legend-item"><span class="legend-color" style="background:#3b82f6;"></span>即期平均匯率</span>
      `;
    }
  }

  mainChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          padding: 12,
          backgroundColor: isLight ? '#ffffff' : '#1e293b',
          titleColor: isLight ? '#0f172a' : '#f8fafc',
          bodyColor: isLight ? '#475569' : '#94a3b8',
          borderColor: 'rgba(99, 102, 241, 0.1)',
          borderWidth: 1,
          boxPadding: 6,
          titleFont: { family: 'Outfit', weight: 'bold' },
          bodyFont: { family: 'Inter' }
        }
      },
      scales: {
        x: {
          grid: { color: gridColor },
          ticks: { color: textColor, font: { family: 'Inter', size: 10 } }
        },
        y: {
          grid: { color: gridColor },
          ticks: { color: textColor, font: { family: 'Inter', size: 10 } }
        }
      }
    }
  });
}

function setupTrendControls() {
  const typeControls = document.getElementById('trendRateTypeControls');
  if (typeControls) {
    const buttons = typeControls.querySelectorAll('button');
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        buttons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeTrendRateType = btn.getAttribute('data-type');
        renderMainTrendChart(activeTrendDays);
      });
    });
  }

  const rangeControls = document.getElementById('trendRangeControls');
  if (rangeControls) {
    const buttons = rangeControls.querySelectorAll('button');
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        buttons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeTrendDays = parseInt(btn.getAttribute('data-range'));
        renderMainTrendChart(activeTrendDays);
      });
    });
  }
}

// --- HISTORY TABLE ---
function updateHistoryTable() {
  const tbody = document.getElementById('historyTableBody');
  if (!tbody) return;

  if (currentRates.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="table-loading">暫無資料</td></tr>';
    return;
  }

  let html = '';
  currentRates.forEach(r => {
    let badgeClass = 'badge-bot';
    let badgeText = '台銀官方';
    if (r.source === 'bot_live') {
      badgeClass = 'badge-bot';
      badgeText = '盤中即時';
    } else if (r.source === 'finmind' || r.source === 'finmind_live') {
      badgeClass = 'badge-manual';
      badgeText = '備用源';
    }

    const spotBuyFormatted = r.spot_buy_rate ? r.spot_buy_rate.toFixed(3) : '-';
    const spotSellFormatted = r.spot_sell_rate ? r.spot_sell_rate.toFixed(3) : '-';
    const spotAvgFormatted = r.spot_average_rate ? r.spot_average_rate.toFixed(2) : '-';

    html += `
      <tr>
        <td style="font-family: var(--font-display); font-weight: 600;">${r.date}</td>
        <td style="font-family: var(--font-display); color: var(--color-buy); font-weight: 500;">${r.buy_rate.toFixed(3)}</td>
        <td style="font-family: var(--font-display); color: var(--color-sell); font-weight: 500;">${r.sell_rate.toFixed(3)}</td>
        <td style="font-family: var(--font-display); color: var(--color-spot-buy); font-weight: 500;">${spotBuyFormatted}</td>
        <td style="font-family: var(--font-display); color: var(--color-spot-sell); font-weight: 500;">${spotSellFormatted}</td>
        <td style="font-family: var(--font-display); color: var(--color-avg); font-weight: 700;">${r.average_rate.toFixed(2)}</td>
        <td style="font-family: var(--font-display); color: var(--color-spot-avg); font-weight: 700;">${spotAvgFormatted}</td>
        <td>${r.last_updated_time}</td>
        <td><span class="badge ${badgeClass}">${badgeText}</span></td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

// --- CALCULATOR LOGIC ---
function setupCalculator() {
  const cnyInput = document.getElementById('calc-cny-input');
  const twdInput = document.getElementById('calc-twd-input');
  if (!cnyInput || !twdInput) return;

  const selector = document.querySelector('.calc-type-selector');
  if (selector) {
    const buttons = selector.querySelectorAll('button');
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        buttons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeCalcMode = btn.getAttribute('data-calc');
        updateCalculatorUI();
        convertCurrency('cny');
      });
    });
  }

  cnyInput.addEventListener('input', () => convertCurrency('cny'));
  twdInput.addEventListener('input', () => convertCurrency('twd'));
}

function updateCalculatorUI() {
  if (currentRates.length === 0) return;
  const rateInfo = document.getElementById('calc-rate-info');
  const tipText = document.getElementById('calc-tip-text');
  if (!rateInfo) return;

  const rate = getActiveCalculatorRate();
  let labelText = '';
  let tip = '';

  if (activeCalcMode === 'cash_sell') {
    labelText = `現金賣出價 (領現鈔)：1 CNY = ${rate.toFixed(3)} TWD`;
    tip = '臨櫃換領人民幣現鈔適用此匯率。若無出國現鈔需求，建議使用即期結匯！';
  } else if (activeCalcMode === 'spot_sell') {
    labelText = `即期賣出價 (網銀結匯)：1 CNY = ${rate.toFixed(3)} TWD`;
    tip = '💡 線上外幣帳戶換匯適用此匯率，通常比現鈔更優惠，成本最低！';
  } else if (activeCalcMode === 'cash_buy') {
    labelText = `現金買進價 (現鈔回台幣)：1 CNY = ${rate.toFixed(3)} TWD`;
    tip = '持有剩餘的人民幣實體紙鈔至台銀換回新台幣適用此匯率。';
  } else if (activeCalcMode === 'spot_buy') {
    labelText = `即期買入價 (外幣回台幣)：1 CNY = ${rate.toFixed(3)} TWD`;
    tip = '外幣帳戶的人民幣轉結回新台幣存款適用此匯率（比現鈔賣回更划算）。';
  } else {
    labelText = `平均參考價 (四捨五入)：1 CNY = ${rate.toFixed(2)} TWD`;
    tip = '中間參考匯率，可用於衡量匯率波動歷史位階。';
  }

  rateInfo.textContent = labelText;
  if (tipText) tipText.textContent = tip;
}

function getActiveCalculatorRate() {
  if (currentRates.length === 0) return 1.0;
  const today = currentRates[0];

  switch (activeCalcMode) {
    case 'cash_sell':
      return today.sell_rate;
    case 'spot_sell':
      return today.spot_sell_rate || today.sell_rate;
    case 'cash_buy':
      return today.buy_rate;
    case 'spot_buy':
      return today.spot_buy_rate || today.buy_rate;
    case 'avg':
    default:
      return today.average_rate;
  }
}

function convertCurrency(source) {
  const cnyInput = document.getElementById('calc-cny-input');
  const twdInput = document.getElementById('calc-twd-input');
  if (!cnyInput || !twdInput) return;

  const rate = getActiveCalculatorRate();

  if (source === 'cny') {
    const val = parseFloat(cnyInput.value);
    if (isNaN(val)) {
      twdInput.value = '';
    } else {
      twdInput.value = (val * rate).toFixed(2);
    }
  } else {
    const val = parseFloat(twdInput.value);
    if (isNaN(val)) {
      cnyInput.value = '';
    } else {
      cnyInput.value = (val / rate).toFixed(2);
    }
  }
}

// --- REFRESH & AUTO UPDATE ---
function setupRefreshButton() {
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      refreshData(true);
    });
  }
}

function setupAutoRefresh() {
  // 每 5 分鐘自動檢查最新即時匯率
  setInterval(() => {
    if (!document.hidden && navigator.onLine) {
      console.log('[CNY Tracker] 觸發排程盤中匯率自動同步...');
      refreshData(false);
    }
  }, 5 * 60 * 1000);

  // 當使用者由其他頁面或 App 切換回本工具時，自動檢查同步
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && navigator.onLine) {
      console.log('[CNY Tracker] 偵測到回到應用程式，自動檢查匯率更新...');
      refreshData(false);
    }
  });
}

function showToastNotification(message) {
  let toast = document.getElementById('appToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'appToast';
    toast.style.position = 'fixed';
    toast.style.bottom = '24px';
    toast.style.right = '24px';
    toast.style.padding = '12px 20px';
    toast.style.background = 'rgba(15, 23, 42, 0.9)';
    toast.style.color = '#fff';
    toast.style.borderRadius = '10px';
    toast.style.boxShadow = '0 8px 24px rgba(0,0,0,0.4)';
    toast.style.border = '1px solid rgba(99, 102, 241, 0.4)';
    toast.style.fontSize = '0.9rem';
    toast.style.zIndex = '9999';
    toast.style.transition = 'all 0.3s ease';
    toast.style.backdropFilter = 'blur(10px)';
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.style.opacity = '1';
  toast.style.transform = 'translateY(0)';

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
  }, 3000);
}

// --- SETTINGS & EXPORT ---
function setupSettingsHandlers() {
  const saveAlertBtn = document.getElementById('saveAlertBtn');
  const clearAlertBtn = document.getElementById('clearAlertBtn');
  const clearCacheBtn = document.getElementById('clearCacheBtn');
  const loadMockBtn = document.getElementById('loadMockBtn');

  if (saveAlertBtn) {
    saveAlertBtn.addEventListener('click', () => {
      const low = document.getElementById('alert-low').value;
      const high = document.getElementById('alert-high').value;
      alertSettings = {
        low: low ? parseFloat(low) : null,
        high: high ? parseFloat(high) : null
      };
      localStorage.setItem('cny_tracker_alert_settings', JSON.stringify(alertSettings));
      showToastNotification('✅ 警示閥值已成功儲存！');
      if (currentRates.length > 0) {
        checkAlertThreshold(currentRates[0].average_rate);
      }
    });
  }

  if (clearAlertBtn) {
    clearAlertBtn.addEventListener('click', () => {
      document.getElementById('alert-low').value = '';
      document.getElementById('alert-high').value = '';
      alertSettings = { low: null, high: null };
      localStorage.removeItem('cny_tracker_alert_settings');
      document.getElementById('thresholdAlertBanner').classList.add('hidden');
      showToastNotification('已清除所有警示設定。');
    });
  }

  if (clearCacheBtn) {
    clearCacheBtn.addEventListener('click', async () => {
      if (!navigator.onLine) {
        alert('您目前處於離線狀態，請先連線網路！');
        return;
      }
      if (confirm('確定要清除本地快取並強制從伺服器拉取最新歷史數據嗎？')) {
        await clearIndexedDBCache();
        await refreshData(true);
      }
    });
  }

  if (loadMockBtn) {
    loadMockBtn.addEventListener('click', async () => {
      if (confirm('確定要載入內建模擬數據進行介面測試嗎？')) {
        await clearIndexedDBCache();
        await cacheRates(MOCK_HISTORICAL_DATA);
        await refreshData();
        showToastNotification('已載入模擬數據！');
      }
    });
  }

  // 匯出按鈕
  const csvBtn = document.getElementById('exportCsvBtn');
  const jsonBtn = document.getElementById('exportJsonBtn');
  if (csvBtn) csvBtn.addEventListener('click', exportToCSV);
  if (jsonBtn) jsonBtn.addEventListener('click', exportToJSON);
}

function exportToCSV() {
  if (currentRates.length === 0) return;

  let csvContent = '\uFEFF'; // UTF-8 BOM
  csvContent += '日期,現金買進(TWD),現金賣出(TWD),即期買入(TWD),即期賣出(TWD),現金平均匯率,即期平均匯率,更新時間,來源\n';

  currentRates.forEach(r => {
    const spotBuy = r.spot_buy_rate ?? '';
    const spotSell = r.spot_sell_rate ?? '';
    const spotAvg = r.spot_average_rate ?? '';
    csvContent += `${r.date},${r.buy_rate},${r.sell_rate},${spotBuy},${spotSell},${r.average_rate},${spotAvg},${r.last_updated_time},${r.source}\n`;
  });

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `cny_rates_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function exportToJSON() {
  if (currentRates.length === 0) return;

  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(currentRates, null, 2));
  const link = document.createElement('a');
  link.setAttribute('href', dataStr);
  link.setAttribute('download', `cny_rates_${new Date().toISOString().slice(0, 10)}.json`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// --- THEME SWITCHING ---
function setupTheme() {
  const toggleBtn = document.getElementById('themeToggle');
  if (!toggleBtn) return;

  const cachedTheme = localStorage.getItem('cny_tracker_theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

  if (cachedTheme === 'light') {
    document.body.classList.add('light-mode');
  } else if (cachedTheme === 'dark' || prefersDark) {
    document.body.classList.remove('light-mode');
  } else {
    document.body.classList.remove('light-mode');
  }

  toggleBtn.addEventListener('click', () => {
    document.body.classList.toggle('light-mode');
    const isLight = document.body.classList.contains('light-mode');
    localStorage.setItem('cny_tracker_theme', isLight ? 'light' : 'dark');

    // 重新繪製走勢圖配合亮暗色
    const activeTab = document.querySelector('.nav-item.active').getAttribute('data-tab');
    if (activeTab === 'trends' && currentRates.length > 0) {
      renderMainTrendChart(activeTrendDays);
    }
  });
}

// --- NAVIGATION & TABS ---
function setupNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  const panels = document.querySelectorAll('.tab-panel');

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(n => n.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));

      item.classList.add('active');
      const tabName = item.getAttribute('data-tab');
      const panel = document.getElementById(`panel-${tabName}`);
      if (panel) panel.classList.add('active');

      if (tabName === 'trends') {
        setTimeout(() => renderMainTrendChart(activeTrendDays), 60);
      }
    });
  });
}

// --- NETWORK MONITORING ---
function setupNetworkMonitoring() {
  const statusIndicator = document.getElementById('networkStatus');
  if (!statusIndicator) return;
  const dot = statusIndicator.querySelector('.status-dot');
  const text = statusIndicator.querySelector('.status-text');

  function updateStatus() {
    const isOnline = navigator.onLine;
    if (isOnline) {
      dot.className = 'status-dot online';
      text.textContent = '在線';
    } else {
      dot.className = 'status-dot offline';
      text.textContent = '離線';
    }
  }

  window.addEventListener('online', () => {
    updateStatus();
    refreshData(false);
  });
  window.addEventListener('offline', updateStatus);
  updateStatus();
}

// --- PWA INSTALLATION PROMPT ---
let deferredInstallPrompt = null;

function setupPwaInstall() {
  const installBox = document.getElementById('installPromptBox');
  const installBtn = document.getElementById('installBtn');
  if (!installBox || !installBtn) return;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBox.style.display = 'flex';
  });

  installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    console.log(`PWA 安裝選擇: ${outcome}`);
    deferredInstallPrompt = null;
    installBox.style.display = 'none';
  });

  window.addEventListener('appinstalled', () => {
    console.log('CNY 匯率追蹤 PWA 安裝成功');
    installBox.style.display = 'none';
  });
}
