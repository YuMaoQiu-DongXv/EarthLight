// Earthlight — 世界地图投影模块
// 纯 JS，无外部依赖，无 import/export。用 <script src="projections.js"> 引入后暴露 window.PROJ。
//
// ── 统一归一化约定 ────────────────────────────────────────────────────────────
// 整幅世界图的宽度固定为 2：经度 ±180° 处 x = ±1（赤道处取得最大宽度）。
// 高度 = 2 * aspect；y 以赤道为 0、向上为正（数学系，SVG 渲染时再翻）。
// 因此关于赤道对称的投影总有：
//     f(90°, lon).y = aspect,  f(-90°, lon).y = -aspect
//     outline() 的 bbox 宽 = 2，高 = 2 * aspect
//
// 注：任务说明中“极点 y = aspect/2”与“aspect = 高/宽、整幅宽 = 2”互相矛盾。
// 宽为 2 时，半高就是 aspect（高 = 2*aspect）；若取 aspect/2，实际高宽比会变成
// aspect/4。本实现以“aspect = 真实世界图高宽比”这一硬约束为准。
//
// 每个投影对象：
//   key       'equirect' | 'mercator' | 'mollweide' | 'robinson' | 'winkel3'
//   name      中文名
//   aspect    高 / 宽（整幅世界图）
//   f(lat,lon) -> {x,y}
//   outline() -> [[x,y], ...]   闭合环（首尾点相同）
//   inverse(x,y) -> {lat,lon}   仅有解析/数值反解的四个投影提供；winkel3 不提供
//
// 经度不做 ±180° 归一化：调用方负责经度缠绕；这样跨日期变更线的绘制由调用方
// 决定，投影本身只做纯数学映射。
// ─────────────────────────────────────────────────────────────────────────────

(function (root) {
  'use strict';

  var DEG = Math.PI / 180;
  var RAD = 180 / Math.PI;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function asinClamped(v) {
    return Math.asin(clamp(v, -1, 1));
  }

  // 由“左右两条边界经线 + 上下闭合边”生成 outline。
  // lon=+180 从 -maxLat 扫到 +maxLat，再沿 lon=-180 扫回来；
  // 对伪圆柱/温克尔类投影，上边（极点连线）与下边是直线段，由闭合隐含。
  // 采样步长 2°，满足 >20 个点，同时保证 bbox 的极值点（lat=0）被采到。
  function buildOutline(proj, maxLat) {
    var pts = [];
    var n = Math.round(maxLat); // 2° 步长：maxLat=90 -> 90 段
    var i, lat;

    var q;
    for (i = 0; i <= n; i++) {
      lat = -maxLat + (2 * maxLat) * (i / n);
      q = proj.f(lat, 180);
      pts.push([q.x, q.y]);
    }
    for (i = n; i >= 0; i--) {
      lat = -maxLat + (2 * maxLat) * (i / n);
      q = proj.f(lat, -180);
      pts.push([q.x, q.y]);
    }
    // 显式闭合（数组按值相等，复制一份首点）
    pts.push([pts[0][0], pts[0][1]]);
    return pts;
  }

  // ── 等距圆柱 equirectangular ────────────────────────────────────────────────
  // 归一化：x = lon/180。真实等距圆柱世界图是 2:1（宽:高），
  // 所以 height = 1、aspect = 0.5，y = lat/180（极点 y = ±0.5）。
  // 任务文字里的 y = lat/90 会得到 1:1 方图（aspect = 1），与 aspect = 0.5
  // 和“真实高宽比”冲突，故这里取 lat/180。
  var equirect = {
    key: 'equirect',
    name: '等距圆柱',
    aspect: 0.5,
    f: function (lat, lon) {
      var la = clamp(lat, -90, 90);
      return { x: lon / 180, y: la / 180 };
    },
    inverse: function (x, y) {
      return { lat: y * 180, lon: x * 180 };
    },
    outline: function () {
      return buildOutline(equirect, 90);
    }
  };

  // ── 墨卡托 Mercator ────────────────────────────────────────────────────────
  // 等角圆柱：x = λ/π，y = ln(tan(π/4 + φ/2))/π。
  // 纬度截断 ±84°：aspect = y(84°) = ln(tan(87°))/π ≈ 0.9386004375，
  // 即整幅图高 ≈ 1.8772、宽 2，高宽比 ≈ 0.9386。
  // （x 与 y 采用同一缩放 1/π，所以形状不会被拉伸。）
  var MERCATOR_LAT_LIMIT = 84;

  function mercatorY(lat) {
    var phi = clamp(lat, -MERCATOR_LAT_LIMIT, MERCATOR_LAT_LIMIT) * DEG;
    return Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI;
  }

  var MERCATOR_ASPECT = mercatorY(MERCATOR_LAT_LIMIT);

  var mercator = {
    key: 'mercator',
    name: '墨卡托',
    aspect: MERCATOR_ASPECT,
    f: function (lat, lon) {
      return { x: lon / 180, y: mercatorY(lat) };
    },
    inverse: function (x, y) {
      // 超出 ±84° 的 y 一律回到截断纬度，保证反解落在图幅内。
      var yy = clamp(y, -MERCATOR_ASPECT, MERCATOR_ASPECT);
      var lat = (2 * Math.atan(Math.exp(Math.PI * yy)) - Math.PI / 2) * RAD;
      return { lat: lat, lon: x * 180 };
    },
    outline: function () {
      return buildOutline(mercator, 84);
    }
  };

  // ── 摩尔威特 Mollweide ─────────────────────────────────────────────────────
  // 解 2θ + sin 2θ = π sin φ（牛顿迭代，θ 初值 = φ，|f| < 1e-10 收敛）。
  // 标准形式：x_raw = (2√2/π) λ cosθ，y_raw = √2 sinθ，世界图 2:1。
  // 归一化到宽 2：x = (λ/π) cosθ = (lon/180) cosθ，y = sinθ / 2。
  // 极点 θ = ±π/2 ⇒ x = 0, y = ±0.5；aspect = 0.5。
  function mollweideTheta(phi) {
    var theta = phi;
    for (var i = 0; i < 100; i++) {
      var fv = 2 * theta + Math.sin(2 * theta) - Math.PI * Math.sin(phi);
      if (Math.abs(fv) < 1e-10) break;
      var fp = 2 + 2 * Math.cos(2 * theta);
      if (Math.abs(fp) < 1e-14) break; // 极点处导数为 0；此时 |fv| 已足够小
      theta -= fv / fp;
    }
    return theta;
  }

  var mollweide = {
    key: 'mollweide',
    name: '摩尔威特',
    aspect: 0.5,
    f: function (lat, lon) {
      var phi = clamp(lat, -90, 90) * DEG;
      var theta = mollweideTheta(phi);
      return {
        x: (lon / 180) * Math.cos(theta),
        y: Math.sin(theta) / 2
      };
    },
    inverse: function (x, y) {
      var theta = asinClamped(2 * y);
      var sinPhi = (2 * theta + Math.sin(2 * theta)) / Math.PI;
      var lat = asinClamped(sinPhi) * RAD;
      var cosTheta = Math.cos(theta);
      // 极点处 cosθ = 0，经度退化；取 0°。
      var lon = Math.abs(cosTheta) < 1e-12 ? 0 : (180 * x) / cosTheta;
      return { lat: lat, lon: lon };
    },
    outline: function () {
      return buildOutline(mollweide, 90);
    }
  };

  // ── 罗宾逊 Robinson ────────────────────────────────────────────────────────
  // 标准 5° 间隔 X/Y 表（Robinson 1974 / Snyder），线性插值。
  // 原始变换（PROJ 兼容常数）为 x_raw = 0.8487 * X(φ) * λ，y_raw = 1.3523 * Y(φ)。
  // 归一化到 lon = ±180°（λ = π）、lat = 0 时 x = 1：
  //     x = X(φ) * λ/π = X(φ) * lon/180
  //     y = 1.3523 * Y(φ) / (0.8487 * π) = 0.5071880041 * Y(φ)
  // 极点 Y(90°) = 1 ⇒ y = ±0.5071880041，即 aspect ≈ 0.507188；
  // 对应经典罗宾逊画布 1.97166:1（高:宽 = 0.50719）。
  // 注意：X(90°) = 0.5322 ≠ 0，所以极点是一条水平线段（图幅上/下边平直）。
  var ROBIN_X = [
    1.0000, 0.9986, 0.9954, 0.9900, 0.9822, 0.9730, 0.9600,
    0.9427, 0.9216, 0.8962, 0.8679, 0.8350, 0.7986, 0.7597,
    0.7186, 0.6732, 0.6213, 0.5722, 0.5322
  ];
  var ROBIN_Y = [
    0.0000, 0.0620, 0.1240, 0.1860, 0.2480, 0.3100, 0.3720,
    0.4340, 0.4958, 0.5571, 0.6176, 0.6769, 0.7346, 0.7903,
    0.8435, 0.8936, 0.9394, 0.9761, 1.0000
  ];
  var ROBIN_Y_SCALE = 1.3523 / (0.8487 * Math.PI);
  var ROBINSON_ASPECT = ROBIN_Y_SCALE; // Y(90°) = 1

  // 线性插值：输入纬度绝对值 [0,90]，返回 {X,Y}
  function robinsonTable(absLat) {
    var a = clamp(absLat, 0, 90);
    var i = Math.min(Math.floor(a / 5), 17);
    var t = (a - i * 5) / 5;
    return {
      X: ROBIN_X[i] + (ROBIN_X[i + 1] - ROBIN_X[i]) * t,
      Y: ROBIN_Y[i] + (ROBIN_Y[i + 1] - ROBIN_Y[i]) * t
    };
  }

  var robinson = {
    key: 'robinson',
    name: '罗宾逊',
    aspect: ROBINSON_ASPECT,
    f: function (lat, lon) {
      var a = Math.min(Math.abs(lat), 90);
      var q = robinsonTable(a);
      return {
        x: (lon / 180) * q.X,
        y: (lat < 0 ? -1 : 1) * q.Y * ROBIN_Y_SCALE
      };
    },
    inverse: function (x, y) {
      var a = clamp(Math.abs(y) / ROBIN_Y_SCALE, 0, 1);
      var i = 0;
      while (i < 17 && ROBIN_Y[i + 1] < a) i++;
      var t = (a - ROBIN_Y[i]) / (ROBIN_Y[i + 1] - ROBIN_Y[i]);
      var latAbs = i * 5 + 5 * t;
      var X = ROBIN_X[i] + (ROBIN_X[i + 1] - ROBIN_X[i]) * t;
      return {
        lat: y < 0 ? -latAbs : latAbs,
        lon: (180 * x) / X
      };
    },
    outline: function () {
      return buildOutline(robinson, 90);
    }
  };

  // ── 温克尔三重 Winkel Tripel ───────────────────────────────────────────────
  // φ1 = arccos(2/π)；α = arccos(cosφ cos(λ/2))；sincα = sinα/α（α→0 取 1）。
  // Aitoff = (2 cosφ sin(λ/2)/sincα, sinφ/sincα)
  // x_raw = (λ cosφ1 + AitoffX)/2，y_raw = (φ + AitoffY)/2。
  // 归一化：在 (φ=0, λ=π) 处 x_raw = (π cosφ1 + π)/2 = 1 + π/2，令 K = 1 + π/2，
  //      x = x_raw / K,  y = y_raw / K。
  // 极点 (φ=π/2)：AitoffX = 0、AitoffY = π/2，故
  //      x = λ cosφ1 / (2K),  y = (π/2)/K = π/(2+π) ≈ 0.6110154704 = aspect。
  // 极点 y 为常数、x 随 λ 线性变化，因此 Winkel Tripel 的极点也是一条水平线段。
  // 该投影没有实用的闭式反解，故不提供 inverse。
  var WINKEL_PHI1 = Math.acos(2 / Math.PI);
  var WINKEL_COS_PHI1 = Math.cos(WINKEL_PHI1); // = 2/π
  var WINKEL_K = 1 + Math.PI / 2;
  var WINKEL_ASPECT = Math.PI / (2 + Math.PI); // = (π/2)/K

  function sinc(alpha) {
    if (Math.abs(alpha) < 1e-8) {
      // 1 - α²/6 + α⁴/120 ...；1e-8 时误差 ~1e-28，足够
      return 1 - (alpha * alpha) / 6;
    }
    return Math.sin(alpha) / alpha;
  }

  var winkel3 = {
    key: 'winkel3',
    name: '温克尔三重',
    aspect: WINKEL_ASPECT,
    f: function (lat, lon) {
      var phi = clamp(lat, -90, 90) * DEG;
      var lam = lon * DEG;
      var cosPhi = Math.cos(phi);
      var sinPhi = Math.sin(phi);
      var alpha = Math.acos(clamp(cosPhi * Math.cos(lam / 2), -1, 1));
      var sc = sinc(alpha);
      var aitoffX = (2 * cosPhi * Math.sin(lam / 2)) / sc;
      var aitoffY = sinPhi / sc;
      return {
        x: (lam * WINKEL_COS_PHI1 + aitoffX) / 2 / WINKEL_K,
        y: (phi + aitoffY) / 2 / WINKEL_K
      };
    },
    // inverse 有意不提供：Winkel Tripel 无闭式反解。
    outline: function () {
      return buildOutline(winkel3, 90);
    }
  };

  root.PROJ = {
    equirect: equirect,
    mercator: mercator,
    mollweide: mollweide,
    robinson: robinson,
    winkel3: winkel3
  };
})(typeof window !== 'undefined' ? window : globalThis);
