/**
 * VoltAssistant - Forecast Module
 * Solar and price forecasting for charge planning
 */

const axios = require('axios');

// Cache for forecasts
let solarForecastCache = { data: null, ts: 0 };
let priceForecastCache = { data: null, ts: 0 };
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Default location (Gijón, Asturias)
const DEFAULT_LAT = 43.5322;
const DEFAULT_LON = -5.6611;

/**
 * Fetch solar forecast from Open-Meteo
 */
async function getSolarForecast(lat = DEFAULT_LAT, lon = DEFAULT_LON, peakPower = 8) {
  const now = Date.now();
  if (solarForecastCache.data && (now - solarForecastCache.ts) < CACHE_TTL) {
    return solarForecastCache.data;
  }
  
  try {
    // Open-Meteo API for solar radiation
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=direct_radiation,diffuse_radiation,cloudcover&timezone=Europe%2FMadrid&forecast_days=2`;
    const res = await axios.get(url, { timeout: 10000 });
    
    if (!res.data?.hourly) {
      throw new Error('Invalid response from Open-Meteo');
    }
    
    const { hourly } = res.data;
    const forecasts = [];
    
    // Calculate estimated solar power for each hour
    for (let i = 0; i < Math.min(48, hourly.time.length); i++) {
      const time = hourly.time[i];
      const directRad = hourly.direct_radiation[i] || 0;
      const diffuseRad = hourly.diffuse_radiation[i] || 0;
      const cloudcover = hourly.cloudcover[i] || 0;
      
      // Simple PV model: total radiation * efficiency * cloud adjustment * peak power
      const totalRad = directRad + diffuseRad;
      const efficiency = 0.18; // 18% panel efficiency
      const cloudFactor = 1 - (cloudcover / 100) * 0.3; // Clouds reduce by up to 30%
      const estimatedWatts = Math.round(totalRad * efficiency * cloudFactor * peakPower / 1000 * 1000);
      
      forecasts.push({
        time,
        hour: new Date(time).getHours(),
        date: time.split('T')[0],
        radiation: Math.round(totalRad),
        cloudcover,
        watts: Math.max(0, estimatedWatts)
      });
    }
    
    // Calculate daily totals
    const today = forecasts.slice(0, 24);
    const tomorrow = forecasts.slice(24, 48);
    
    const todayKwh = today.reduce((sum, f) => sum + f.watts, 0) / 1000;
    const tomorrowKwh = tomorrow.reduce((sum, f) => sum + f.watts, 0) / 1000;
    
    // Find peak hour
    const peakToday = today.reduce((max, f) => f.watts > max.watts ? f : max, { watts: 0 });
    
    const result = {
      location: { lat, lon },
      peakPower,
      today: {
        date: today[0]?.date,
        totalKwh: Math.round(todayKwh * 10) / 10,
        peakHour: peakToday.hour,
        peakWatts: peakToday.watts,
        forecasts: today
      },
      tomorrow: {
        date: tomorrow[0]?.date,
        totalKwh: Math.round(tomorrowKwh * 10) / 10,
        forecasts: tomorrow
      },
      fetchedAt: new Date().toISOString()
    };
    
    solarForecastCache = { data: result, ts: now };
    return result;
  } catch (e) {
    console.error('Solar forecast error:', e.message);
    return solarForecastCache.data || { error: e.message, today: { totalKwh: 0, forecasts: [] }, tomorrow: { totalKwh: 0, forecasts: [] } };
  }
}

/**
 * Fetch PVPC prices from ESIOS API
 */
async function getPVPCPrices() {
  const now = Date.now();
  if (priceForecastCache.data && (now - priceForecastCache.ts) < CACHE_TTL) {
    return priceForecastCache.data;
  }
  
  try {
    // ESIOS public API for PVPC prices
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    
    // Try to get prices from ESIOS (indicator 1001 = PVPC)
    const url = `https://api.esios.ree.es/indicators/1001?start_date=${today}T00:00&end_date=${tomorrow}T23:59`;
    
    const res = await axios.get(url, {
      headers: {
        'Accept': 'application/json',
        'x-api-key': 'your-optional-api-key' // Works without for basic requests
      },
      timeout: 10000
    });
    
    const prices = [];
    if (res.data?.indicator?.values) {
      for (const v of res.data.indicator.values) {
        const date = new Date(v.datetime);
        prices.push({
          time: v.datetime,
          date: date.toISOString().split('T')[0],
          hour: date.getHours(),
          price: v.value / 1000, // Convert from €/MWh to €/kWh
          priceFormatted: (v.value / 1000).toFixed(4) + ' €/kWh'
        });
      }
    }
    
    // Separate today and tomorrow
    const todayPrices = prices.filter(p => p.date === today);
    const tomorrowPrices = prices.filter(p => p.date === tomorrow);
    
    // Calculate stats
    const calcStats = (arr) => {
      if (!arr.length) return { avg: 0, min: 0, max: 0, cheapest: [], expensive: [] };
      const sorted = [...arr].sort((a, b) => a.price - b.price);
      const avg = arr.reduce((s, p) => s + p.price, 0) / arr.length;
      return {
        avg: Math.round(avg * 10000) / 10000,
        min: sorted[0].price,
        max: sorted[sorted.length - 1].price,
        cheapest: sorted.slice(0, 6).map(p => p.hour),
        expensive: sorted.slice(-6).map(p => p.hour)
      };
    };
    
    const result = {
      today: {
        date: today,
        prices: todayPrices,
        stats: calcStats(todayPrices)
      },
      tomorrow: {
        date: tomorrow,
        prices: tomorrowPrices,
        stats: calcStats(tomorrowPrices),
        available: tomorrowPrices.length >= 20
      },
      fetchedAt: new Date().toISOString()
    };
    
    priceForecastCache = { data: result, ts: now };
    return result;
  } catch (e) {
    console.error('PVPC prices error:', e.message);
    // Return cached or empty
    return priceForecastCache.data || { 
      error: e.message, 
      today: { prices: [], stats: {} }, 
      tomorrow: { prices: [], stats: {}, available: false } 
    };
  }
}

/**
 * Generate optimal charging plan based on prices and solar forecast
 */
function generateChargingPlan(prices, solar, battery = {}) {
  const capacity = battery.capacityKwh || 32.6;
  const currentSoc = battery.currentSoc || 50;
  const targetSoc = battery.targetSoc || 80;
  const chargeRate = battery.chargeRateKw || 6;
  
  const neededKwh = (targetSoc - currentSoc) / 100 * capacity;
  if (neededKwh <= 0) {
    return {
      action: 'hold',
      reason: `Battery already at ${currentSoc}% (target: ${targetSoc}%)`,
      chargeHours: [],
      estimatedCost: 0
    };
  }
  
  // Calculate how much solar will cover
  const hour = new Date().getHours();
  const remainingSolarToday = (solar.today?.forecasts || [])
    .filter(f => f.hour >= hour)
    .reduce((sum, f) => sum + f.watts, 0) / 1000;
  
  const neededFromGrid = Math.max(0, neededKwh - remainingSolarToday);
  
  if (neededFromGrid <= 0) {
    return {
      action: 'wait_for_solar',
      reason: `Solar forecast (${remainingSolarToday.toFixed(1)} kWh) covers charging needs`,
      chargeHours: [],
      estimatedCost: 0,
      solarCoverage: remainingSolarToday
    };
  }
  
  // Find cheapest hours to charge from grid
  const todayPrices = prices.today?.prices || [];
  const futurePrices = todayPrices.filter(p => p.hour >= hour);
  const sorted = [...futurePrices].sort((a, b) => a.price - b.price);
  
  // Calculate hours needed
  const hoursNeeded = Math.ceil(neededFromGrid / chargeRate);
  const chargeHours = sorted.slice(0, hoursNeeded);
  
  // Calculate cost
  const estimatedCost = chargeHours.reduce((sum, h) => sum + (h.price * chargeRate), 0);
  const avgPrice = chargeHours.reduce((sum, h) => sum + h.price, 0) / (chargeHours.length || 1);
  
  // Calculate savings vs charging now
  const currentPrice = todayPrices.find(p => p.hour === hour)?.price || avgPrice;
  const costIfNow = neededFromGrid * currentPrice;
  const savings = costIfNow - estimatedCost;
  
  return {
    action: chargeHours.some(h => h.hour === hour) ? 'charge_now' : 'wait_for_cheap',
    reason: chargeHours.some(h => h.hour === hour) 
      ? `Current hour is optimal for charging (${currentPrice.toFixed(4)} €/kWh)`
      : `Wait until ${chargeHours[0]?.hour}:00 for cheaper rate (${chargeHours[0]?.price.toFixed(4)} €/kWh)`,
    chargeHours: chargeHours.map(h => h.hour).sort((a, b) => a - b),
    nextChargeHour: chargeHours.sort((a, b) => a.hour - b.hour)[0]?.hour,
    neededKwh: Math.round(neededFromGrid * 10) / 10,
    estimatedCost: Math.round(estimatedCost * 100) / 100,
    avgPrice: Math.round(avgPrice * 10000) / 10000,
    savings: Math.round(savings * 100) / 100,
    solarCoverage: Math.round(remainingSolarToday * 10) / 10
  };
}

/**
 * Calculate estimated monthly savings
 */
function calculateMonthlySavings(history, prices) {
  // Estimate based on average daily patterns
  const avgDailyUsage = 25; // kWh
  const avgSolarGen = 15; // kWh
  const avgBatterySize = 32.6; // kWh
  
  // Without optimization: all from grid at avg price
  const avgPrice = prices.today?.stats?.avg || 0.15;
  const maxPrice = prices.today?.stats?.max || 0.25;
  const minPrice = prices.today?.stats?.min || 0.05;
  
  // With optimization: solar + cheap charging
  const solarCoverage = avgSolarGen / avgDailyUsage;
  const batteryShift = Math.min(avgBatterySize / avgDailyUsage, 0.5); // How much we can shift
  
  const baseMonthlyBill = avgDailyUsage * avgPrice * 30;
  const optimizedBill = avgDailyUsage * 30 * (
    solarCoverage * 0 + // Solar is free
    batteryShift * (1 - solarCoverage) * minPrice + // Battery charged at min price
    (1 - solarCoverage - batteryShift * (1 - solarCoverage)) * avgPrice // Rest at avg
  );
  
  return {
    baseMonthlyBill: Math.round(baseMonthlyBill),
    optimizedMonthlyBill: Math.round(optimizedBill),
    monthlySavings: Math.round(baseMonthlyBill - optimizedBill),
    savingsPercent: Math.round((1 - optimizedBill / baseMonthlyBill) * 100),
    assumptions: {
      dailyUsageKwh: avgDailyUsage,
      dailySolarKwh: avgSolarGen,
      batteryKwh: avgBatterySize
    }
  };
}

module.exports = {
  getSolarForecast,
  getPVPCPrices,
  generateChargingPlan,
  calculateMonthlySavings
};
