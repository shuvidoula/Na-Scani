(function () {
  "use strict";

  var DB_NAME = "na-scani-db";
  var STORE_NAME = "documents";
  var DOC_ID = "active-document";
  var MAX_SCAN_WIDTH = 1600;
  var state = {
    db: null,
    stream: null,
    pages: [],
    selected: 0,
    mode: "bw",
    scannerStatus: "loading",
    detecting: false,
    lastBox: null,
    lastShape: null,
    scanner: null,
    scannerReady: false,
    cropMode: false,
    cropRect: null,
    cropStart: null
  };

  function $(selector) {
    return document.querySelector(selector);
  }

  function toast(text) {
    var el = $("#appToast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () {
      el.classList.remove("show");
      el.textContent = "";
    }, 1800);
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = function () {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      };
      request.onsuccess = function () {
        state.db = request.result;
        resolve();
      };
      request.onerror = function () {
        reject(request.error);
      };
    });
  }

  function saveDocument() {
    if (!state.db) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var tx = state.db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({
        id: DOC_ID,
        pages: state.pages,
        selected: state.selected,
        updatedAt: new Date().toISOString()
      });
      tx.oncomplete = resolve;
      tx.onerror = function () { reject(tx.error); };
    });
  }

  function loadDocument() {
    if (!state.db) return Promise.resolve();
    return new Promise(function (resolve) {
      var tx = state.db.transaction(STORE_NAME, "readonly");
      var request = tx.objectStore(STORE_NAME).get(DOC_ID);
      request.onsuccess = function () {
        if (request.result) {
          state.pages = request.result.pages || [];
          state.selected = Math.min(request.result.selected || 0, Math.max(0, state.pages.length - 1));
        }
        resolve();
      };
      request.onerror = resolve;
    });
  }

  function dataUrlToImage(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve) {
      canvas.toBlob(resolve, type, quality);
    });
  }

  function waitForOpenCv() {
    if (!window.cv) return Promise.resolve(false);
    if (window.cv.Mat) return Promise.resolve(true);
    if (typeof window.cv.then === "function") {
      return new Promise(function (resolve) {
        try {
          window.cv.then(function () { resolve(true); });
        } catch (e) {
          resolve(false);
        }
      });
    }
    return new Promise(function (resolve) {
      var attempts = 0;
      var timer = setInterval(function () {
        attempts += 1;
        if (window.cv && window.cv.Mat) {
          clearInterval(timer);
          resolve(true);
        } else if (attempts > 80) {
          clearInterval(timer);
          resolve(false);
        }
      }, 50);
    });
  }

  async function prepareScanner() {
    if (state.scannerReady) return true;
    var ready = await waitForOpenCv();
    if (!ready || !window.jscanify) return false;
    state.scanner = state.scanner || new window.jscanify();
    state.scannerReady = true;
    return true;
  }

  function fitSize(width, height, maxWidth) {
    if (width <= maxWidth) return { width: width, height: height };
    var ratio = maxWidth / width;
    return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function median(values) {
    if (!values.length) return 0;
    values.sort(function (a, b) { return a - b; });
    return values[Math.floor(values.length / 2)];
  }

  function a4CenterBox(width, height) {
    var portraitRatio = 1 / 1.414;
    var boxHeight = height * .88;
    var boxWidth = boxHeight * portraitRatio;
    if (boxWidth > width * .88) {
      boxWidth = width * .88;
      boxHeight = boxWidth / portraitRatio;
    }
    return {
      x: Math.round((width - boxWidth) / 2),
      y: Math.round((height - boxHeight) / 2),
      width: Math.round(boxWidth),
      height: Math.round(boxHeight),
      detected: false
    };
  }

  function expandToA4Box(box, canvasWidth, canvasHeight) {
    var portraitRatio = 1 / 1.414;
    var landscapeRatio = 1.414;
    var ratio = box.width / box.height;
    var targetRatio = ratio > 1 ? landscapeRatio : portraitRatio;
    var centerX = box.x + box.width / 2;
    var centerY = box.y + box.height / 2;
    var width = box.width;
    var height = box.height;
    if (width / height > targetRatio) height = width / targetRatio;
    else width = height * targetRatio;
    width *= 1.08;
    height *= 1.08;
    width = Math.min(width, canvasWidth);
    height = Math.min(height, canvasHeight);
    return {
      x: Math.round(clamp(centerX - width / 2, 0, canvasWidth - width)),
      y: Math.round(clamp(centerY - height / 2, 0, canvasHeight - height)),
      width: Math.round(width),
      height: Math.round(height),
      detected: true
    };
  }

  function captureToCanvas(source) {
    var sourceWidth = source.videoWidth || source.naturalWidth || source.width;
    var sourceHeight = source.videoHeight || source.naturalHeight || source.height;
    var size = fitSize(sourceWidth, sourceHeight, MAX_SCAN_WIDTH);
    var canvas = $("#workCanvas");
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    canvas.width = size.width;
    canvas.height = size.height;
    ctx.drawImage(source, 0, 0, size.width, size.height);
    return canvas;
  }

  function a4OutputSize(sourceCanvas) {
    if (sourceCanvas.width > sourceCanvas.height) {
      return { width: 1754, height: 1240 };
    }
    return { width: 1240, height: 1754 };
  }

  function polygonArea(points) {
    var area = 0;
    for (var i = 0; i < points.length; i += 1) {
      var next = points[(i + 1) % points.length];
      area += points[i].x * next.y - next.x * points[i].y;
    }
    return Math.abs(area / 2);
  }

  function orderCorners(points) {
    var topLeft = points[0];
    var topRight = points[0];
    var bottomLeft = points[0];
    var bottomRight = points[0];
    points.forEach(function (point) {
      var sum = point.x + point.y;
      var diff = point.x - point.y;
      if (sum < topLeft.x + topLeft.y) topLeft = point;
      if (sum > bottomRight.x + bottomRight.y) bottomRight = point;
      if (diff > topRight.x - topRight.y) topRight = point;
      if (diff < bottomLeft.x - bottomLeft.y) bottomLeft = point;
    });
    return {
      topLeftCorner: topLeft,
      topRightCorner: topRight,
      bottomLeftCorner: bottomLeft,
      bottomRightCorner: bottomRight
    };
  }

  function cornersToArray(corners) {
    return [
      corners.topLeftCorner,
      corners.topRightCorner,
      corners.bottomRightCorner,
      corners.bottomLeftCorner
    ];
  }

  function cornerScore(corners, canvasWidth, canvasHeight) {
    var points = cornersToArray(corners);
    var area = polygonArea(points);
    var imageArea = canvasWidth * canvasHeight;
    if (area < imageArea * .004 || area > imageArea * .94) return 0;
    var top = Math.hypot(corners.topRightCorner.x - corners.topLeftCorner.x, corners.topRightCorner.y - corners.topLeftCorner.y);
    var bottom = Math.hypot(corners.bottomRightCorner.x - corners.bottomLeftCorner.x, corners.bottomRightCorner.y - corners.bottomLeftCorner.y);
    var left = Math.hypot(corners.bottomLeftCorner.x - corners.topLeftCorner.x, corners.bottomLeftCorner.y - corners.topLeftCorner.y);
    var right = Math.hypot(corners.bottomRightCorner.x - corners.topRightCorner.x, corners.bottomRightCorner.y - corners.topRightCorner.y);
    var width = (top + bottom) / 2;
    var height = (left + right) / 2;
    if (!width || !height) return 0;
    var ratio = width / height;
    var ratioErr = Math.min(Math.abs(ratio - .707), Math.abs(ratio - 1.414));
    var ratioScore = Math.max(.15, 1 - ratioErr * 1.4);
    var centerX = points.reduce(function (sum, point) { return sum + point.x; }, 0) / 4;
    var centerY = points.reduce(function (sum, point) { return sum + point.y; }, 0) / 4;
    var centerPenalty = Math.hypot(centerX - canvasWidth / 2, centerY - canvasHeight / 2) / Math.hypot(canvasWidth / 2, canvasHeight / 2);
    return area * ratioScore * Math.max(.35, 1 - centerPenalty * .45);
  }

  function readApproxPoints(approx) {
    var points = [];
    for (var i = 0; i < approx.data32S.length; i += 2) {
      points.push({ x: approx.data32S[i], y: approx.data32S[i + 1] });
    }
    return points;
  }

  function findPaperByLightMask(sourceCanvas) {
    if (!window.cv || !window.cv.Mat) return null;
    var src = null;
    var rgba = null;
    var mask = null;
    var kernel = null;
    var contours = null;
    var hierarchy = null;
    var best = null;
    var bestScore = 0;
    try {
      src = cv.imread(sourceCanvas);
      var data = src.data;
      mask = new cv.Mat(sourceCanvas.height, sourceCanvas.width, cv.CV_8UC1);
      var maskData = mask.data;
      var width = sourceCanvas.width;
      var height = sourceCanvas.height;
      var borderValues = [];
      var step = Math.max(8, Math.round(Math.min(width, height) / 120));
      var border = Math.round(Math.min(width, height) * .08);
      for (var sy = 0; sy < height; sy += step) {
        for (var sx = 0; sx < width; sx += step) {
          if (sx > border && sx < width - border && sy > border && sy < height - border) continue;
          var si = (sy * width + sx) * 4;
          borderValues.push(data[si] * .299 + data[si + 1] * .587 + data[si + 2] * .114);
        }
      }
      var bg = median(borderValues);
      var threshold = clamp(bg + 18, 112, 188);
      for (var y = 0; y < height; y += 1) {
        for (var x = 0; x < width; x += 1) {
          var i = (y * width + x) * 4;
          var r = data[i];
          var g = data[i + 1];
          var b = data[i + 2];
          var luma = r * .299 + g * .587 + b * .114;
          var spread = Math.max(r, g, b) - Math.min(r, g, b);
          var neutral = spread < 78 || (luma > 172 && spread < 110);
          var paper = neutral && luma > threshold;
          maskData[y * width + x] = paper ? 255 : 0;
        }
      }
      kernel = cv.Mat.ones(9, 9, cv.CV_8U);
      cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);
      cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
      cv.dilate(mask, mask, kernel, new cv.Point(-1, -1), 2);
      contours = new cv.MatVector();
      hierarchy = new cv.Mat();
      cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      for (var c = 0; c < contours.size(); c += 1) {
        var contour = contours.get(c);
        var area = cv.contourArea(contour);
        if (area < width * height * .035) {
          contour.delete();
          continue;
        }
        var rect = cv.boundingRect(contour);
        var touchesTooMuch = rect.x <= 1 && rect.y <= 1 && rect.width >= width - 2 && rect.height >= height - 2;
        if (touchesTooMuch) {
          contour.delete();
          continue;
        }
        var peri = cv.arcLength(contour, true);
        var localBest = null;
        [.018, .026, .04, .065, .09].some(function (epsilon) {
          var approx = new cv.Mat();
          cv.approxPolyDP(contour, approx, peri * epsilon, true);
          if (approx.rows === 4) {
            localBest = orderCorners(readApproxPoints(approx));
            approx.delete();
            return true;
          }
          approx.delete();
          return false;
        });
        if (!localBest) {
          var minRect = cv.minAreaRect(contour);
          localBest = orderCorners(cv.RotatedRect.points(minRect).map(function (point) {
            return { x: point.x, y: point.y };
          }));
        }
        var score = cornerScore(localBest, width, height) * 1.28;
        if (score > bestScore) {
          bestScore = score;
          best = localBest;
        }
        contour.delete();
      }
    } catch (e) {
      best = null;
    } finally {
      if (src) src.delete();
      if (rgba) rgba.delete();
      if (mask) mask.delete();
      if (kernel) kernel.delete();
      if (contours) contours.delete();
      if (hierarchy) hierarchy.delete();
    }
    return bestScore > sourceCanvas.width * sourceCanvas.height * .02 ? best : null;
  }

  function findDocumentCorners(sourceCanvas) {
    if (!window.cv || !window.cv.Mat) return null;
    var lightMaskCorners = findPaperByLightMask(sourceCanvas);
    if (lightMaskCorners) return lightMaskCorners;
    var src = null;
    var gray = null;
    var blur = null;
    var edges = null;
    var kernel = null;
    var contours = null;
    var hierarchy = null;
    var best = null;
    var bestScore = 0;
    try {
      src = cv.imread(sourceCanvas);
      gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      blur = new cv.Mat();
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
      edges = new cv.Mat();
      cv.Canny(blur, edges, 35, 120);
      kernel = cv.Mat.ones(5, 5, cv.CV_8U);
      cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 2);
      cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
      contours = new cv.MatVector();
      hierarchy = new cv.Mat();
      cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      for (var i = 0; i < contours.size(); i += 1) {
        var contour = contours.get(i);
        var area = cv.contourArea(contour);
        if (area < sourceCanvas.width * sourceCanvas.height * .004) {
          contour.delete();
          continue;
        }
        var peri = cv.arcLength(contour, true);
        var foundQuad = [.018, .026, .035, .052, .075].some(function (epsilon) {
          var approx = new cv.Mat();
          cv.approxPolyDP(contour, approx, peri * epsilon, true);
          if (approx.rows === 4) {
            var corners = orderCorners(readApproxPoints(approx));
            var score = cornerScore(corners, sourceCanvas.width, sourceCanvas.height);
            if (score > bestScore) {
              bestScore = score;
              best = corners;
            }
            approx.delete();
            return true;
          }
          approx.delete();
          return false;
        });
        if (!foundQuad) {
          try {
            var rect = cv.minAreaRect(contour);
            var rectPoints = cv.RotatedRect.points(rect).map(function (point) {
              return { x: point.x, y: point.y };
            });
            var rectCorners = orderCorners(rectPoints);
            var rectScore = cornerScore(rectCorners, sourceCanvas.width, sourceCanvas.height) * .72;
            if (rectScore > bestScore) {
              bestScore = rectScore;
              best = rectCorners;
            }
          } catch (e) {}
        }
        contour.delete();
      }
    } catch (e) {
      best = null;
    } finally {
      if (src) src.delete();
      if (gray) gray.delete();
      if (blur) blur.delete();
      if (edges) edges.delete();
      if (kernel) kernel.delete();
      if (contours) contours.delete();
      if (hierarchy) hierarchy.delete();
    }
    return bestScore > sourceCanvas.width * sourceCanvas.height * .006 ? best : null;
  }

  function scaleCorners(corners, scaleX, scaleY) {
    if (!corners) return null;
    return {
      topLeftCorner: { x: corners.topLeftCorner.x * scaleX, y: corners.topLeftCorner.y * scaleY },
      topRightCorner: { x: corners.topRightCorner.x * scaleX, y: corners.topRightCorner.y * scaleY },
      bottomLeftCorner: { x: corners.bottomLeftCorner.x * scaleX, y: corners.bottomLeftCorner.y * scaleY },
      bottomRightCorner: { x: corners.bottomRightCorner.x * scaleX, y: corners.bottomRightCorner.y * scaleY }
    };
  }

  async function extractWithScanner(sourceCanvas) {
    if (!(await prepareScanner())) return null;
    try {
      var size = a4OutputSize(sourceCanvas);
      var corners = findDocumentCorners(sourceCanvas);
      var result = corners ?
        state.scanner.extractPaper(sourceCanvas, size.width, size.height, corners) :
        state.scanner.extractPaper(sourceCanvas, size.width, size.height);
      if (!result || !result.width || !result.height) return null;
      return result;
    } catch (e) {
      return null;
    }
  }

  function trimWarpedPaper(canvas) {
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    var image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var data = image.data;
    var width = canvas.width;
    var height = canvas.height;
    function isPaperPixel(x, y) {
      var i = (y * width + x) * 4;
      var r = data[i];
      var g = data[i + 1];
      var b = data[i + 2];
      var luma = r * .299 + g * .587 + b * .114;
      var spread = Math.max(r, g, b) - Math.min(r, g, b);
      return luma > 132 && (spread < 88 || luma > 178);
    }
    function isDarkPixel(x, y) {
      var i = (y * width + x) * 4;
      var r = data[i];
      var g = data[i + 1];
      var b = data[i + 2];
      var luma = r * .299 + g * .587 + b * .114;
      return luma < 78;
    }
    function rowPaperRatio(y) {
      var hits = 0;
      var dark = 0;
      var total = 0;
      var step = Math.max(2, Math.round(width / 360));
      for (var x = 0; x < width; x += step) {
        total += 1;
        if (isPaperPixel(x, y)) hits += 1;
        if (isDarkPixel(x, y)) dark += 1;
      }
      return total ? { paper: hits / total, dark: dark / total } : { paper: 0, dark: 1 };
    }
    function columnPaperRatio(x) {
      var hits = 0;
      var dark = 0;
      var total = 0;
      var step = Math.max(2, Math.round(height / 480));
      for (var y = 0; y < height; y += step) {
        total += 1;
        if (isPaperPixel(x, y)) hits += 1;
        if (isDarkPixel(x, y)) dark += 1;
      }
      return total ? { paper: hits / total, dark: dark / total } : { paper: 0, dark: 1 };
    }
    var top = 0;
    var bottom = height - 1;
    var left = 0;
    var right = width - 1;
    while (top < height * .28) {
      var topRatio = rowPaperRatio(top);
      if (topRatio.paper >= .76 && topRatio.dark <= .018) break;
      top += 1;
    }
    while (bottom > height * .72) {
      var bottomRatio = rowPaperRatio(bottom);
      if (bottomRatio.paper >= .76 && bottomRatio.dark <= .018) break;
      bottom -= 1;
    }
    while (left < width * .22) {
      var leftRatio = columnPaperRatio(left);
      if (leftRatio.paper >= .74 && leftRatio.dark <= .018) break;
      left += 1;
    }
    while (right > width * .78) {
      var rightRatio = columnPaperRatio(right);
      if (rightRatio.paper >= .74 && rightRatio.dark <= .018) break;
      right -= 1;
    }
    top = clamp(top + 2, 0, height - 1);
    bottom = clamp(bottom - 2, 0, height - 1);
    left = clamp(left + 2, 0, width - 1);
    right = clamp(right - 2, 0, width - 1);
    var trimW = right - left + 1;
    var trimH = bottom - top + 1;
    if (trimW < width * .65 || trimH < height * .65) return;
    if (left < 3 && top < 3 && right > width - 4 && bottom > height - 4) return;
    var copy = document.createElement("canvas");
    copy.width = trimW;
    copy.height = trimH;
    copy.getContext("2d").drawImage(canvas, left, top, trimW, trimH, 0, 0, trimW, trimH);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(copy, 0, 0, width, height);
  }

  function detectDocumentBox(canvas) {
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    var step = Math.max(3, Math.round(Math.min(canvas.width, canvas.height) / 220));
    var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    var border = [];
    var center = [];
    var borderSize = Math.max(step * 4, Math.round(Math.min(canvas.width, canvas.height) * .06));
    var centerLeft = canvas.width * .34;
    var centerRight = canvas.width * .66;
    var centerTop = canvas.height * .34;
    var centerBottom = canvas.height * .66;
    for (var sampleY = 0; sampleY < canvas.height; sampleY += step * 2) {
      for (var sampleX = 0; sampleX < canvas.width; sampleX += step * 2) {
        var sampleI = (sampleY * canvas.width + sampleX) * 4;
        var sampleLuma = data[sampleI] * .299 + data[sampleI + 1] * .587 + data[sampleI + 2] * .114;
        if (sampleX < borderSize || sampleY < borderSize || sampleX > canvas.width - borderSize || sampleY > canvas.height - borderSize) {
          border.push(sampleLuma);
        }
        if (sampleX > centerLeft && sampleX < centerRight && sampleY > centerTop && sampleY < centerBottom) {
          center.push(sampleLuma);
        }
      }
    }
    var bgLuma = median(border);
    var centerLuma = median(center);
    var minX = canvas.width;
    var minY = canvas.height;
    var maxX = 0;
    var maxY = 0;
    var count = 0;
    var edgeMinX = canvas.width;
    var edgeMinY = canvas.height;
    var edgeMaxX = 0;
    var edgeMaxY = 0;
    var edgeCount = 0;
    var usefulLeft = canvas.width * .04;
    var usefulRight = canvas.width * .96;
    var usefulTop = canvas.height * .04;
    var usefulBottom = canvas.height * .96;
    for (var y = 0; y < canvas.height; y += step) {
      for (var x = 0; x < canvas.width; x += step) {
        var i = (y * canvas.width + x) * 4;
        var r = data[i];
        var g = data[i + 1];
        var b = data[i + 2];
        var brightness = r * .299 + g * .587 + b * .114;
        var spread = Math.max(r, g, b) - Math.min(r, g, b);
        var paperLike = spread < 92 && (
          brightness > Math.max(112, bgLuma + 14) ||
          brightness > Math.max(128, centerLuma - 30) ||
          (brightness > 150 && Math.abs(brightness - centerLuma) < 58)
        );
        if (paperLike && x > usefulLeft && x < usefulRight && y > usefulTop && y < usefulBottom) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
          count += 1;
        }
        if (x >= step && y >= step) {
          var leftI = (y * canvas.width + x - step) * 4;
          var topI = ((y - step) * canvas.width + x) * 4;
          var leftLuma = data[leftI] * .299 + data[leftI + 1] * .587 + data[leftI + 2] * .114;
          var topLuma = data[topI] * .299 + data[topI + 1] * .587 + data[topI + 2] * .114;
          var edge = Math.abs(brightness - leftLuma) + Math.abs(brightness - topLuma);
          if (edge > 48 && x > usefulLeft && x < usefulRight && y > usefulTop && y < usefulBottom) {
            edgeMinX = Math.min(edgeMinX, x);
            edgeMinY = Math.min(edgeMinY, y);
            edgeMaxX = Math.max(edgeMaxX, x);
            edgeMaxY = Math.max(edgeMaxY, y);
            edgeCount += 1;
          }
        }
      }
    }
    var area = (maxX - minX) * (maxY - minY);
    var edgeArea = (edgeMaxX - edgeMinX) * (edgeMaxY - edgeMinY);
    if ((count < 45 || area < canvas.width * canvas.height * .10) && edgeCount > 70 && edgeArea > canvas.width * canvas.height * .16) {
      minX = edgeMinX;
      minY = edgeMinY;
      maxX = edgeMaxX;
      maxY = edgeMaxY;
      area = edgeArea;
    }
    if (area < canvas.width * canvas.height * .10) {
      return a4CenterBox(canvas.width, canvas.height);
    }
    var pad = Math.round(Math.min(canvas.width, canvas.height) * .018);
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(canvas.width, maxX + pad);
    maxY = Math.min(canvas.height, maxY + pad);
    return expandToA4Box({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, canvas.width, canvas.height);
  }

  function applyScanLook(canvas, mode) {
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    var image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var data = image.data;
    for (var i = 0; i < data.length; i += 4) {
      var gray = data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114;
      if (mode === "bw") {
        var value = gray > 154 ? 255 : 0;
        data[i] = value;
        data[i + 1] = value;
        data[i + 2] = value;
      } else if (mode === "gray") {
        var lifted = Math.max(0, Math.min(255, (gray - 22) * 1.24));
        data[i] = lifted;
        data[i + 1] = lifted;
        data[i + 2] = lifted;
      } else {
        data[i] = Math.max(0, Math.min(255, (data[i] - 10) * 1.12));
        data[i + 1] = Math.max(0, Math.min(255, (data[i + 1] - 10) * 1.12));
        data[i + 2] = Math.max(0, Math.min(255, (data[i + 2] - 10) * 1.12));
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  async function processCanvas(sourceCanvas) {
    var crop = $("#cropCanvas");
    var ctx = crop.getContext("2d", { willReadFrequently: true });
    var scannerCanvas = await extractWithScanner(sourceCanvas);
    var detected = !!scannerCanvas;
    if (scannerCanvas) {
      crop.width = scannerCanvas.width;
      crop.height = scannerCanvas.height;
      ctx.drawImage(scannerCanvas, 0, 0);
      trimWarpedPaper(crop);
    } else {
      var box = detectDocumentBox(sourceCanvas);
      crop.width = box.width;
      crop.height = box.height;
      ctx.drawImage(sourceCanvas, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
      detected = box.detected;
    }
    applyScanLook(crop, state.mode);
    var blob = await canvasToBlob(crop, "image/jpeg", .88);
    return {
      id: uid(),
      dataUrl: await blobToDataUrl(blob),
      rotation: 0,
      detected: detected
    };
  }

  async function addScanFromSource(source) {
    var page = await processCanvas(captureToCanvas(source));
    state.pages.push(page);
    state.selected = state.pages.length - 1;
    await saveDocument();
    render();
    toast(page.detected ? "Сторінку обрізано автоматично." : "Сторінку додано.");
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $("#cameraFallback").hidden = false;
      return;
    }
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      });
      $("#camera").srcObject = state.stream;
      $("#cameraFallback").hidden = true;
      requestAnimationFrame(drawGuide);
    } catch (e) {
      $("#cameraFallback").hidden = false;
      toast("Камеру не відкрито. Додайте фото.");
    }
  }

  function drawGuide() {
    var video = $("#camera");
    var canvas = $("#guideCanvas");
    var panel = canvas.parentElement;
    canvas.width = panel.clientWidth;
    canvas.height = panel.clientHeight;
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(0, 0, 0, .18)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    var box = {
      x: canvas.width * .08,
      y: canvas.height * .08,
      width: canvas.width * .84,
      height: canvas.height * .84
    };
    if (video.videoWidth && !state.detecting) {
      state.detecting = true;
      setTimeout(function () {
        try {
          var temp = document.createElement("canvas");
          temp.width = 360;
          temp.height = Math.max(240, Math.round(360 * video.videoHeight / video.videoWidth));
          temp.getContext("2d").drawImage(video, 0, 0, temp.width, temp.height);
          var corners = state.scannerReady ? findDocumentCorners(temp) : null;
          state.lastShape = corners;
          state.lastBox = corners ? null : detectDocumentBox(temp);
        } catch (e) {
          state.lastShape = null;
          state.lastBox = null;
        }
        state.detecting = false;
      }, 260);
    }
    if (state.lastShape) {
      var tempHeight = Math.max(240, Math.round(360 * video.videoHeight / video.videoWidth));
      var scaledCorners = scaleCorners(state.lastShape, canvas.width / 360, canvas.height / tempHeight);
      var points = cornersToArray(scaledCorners);
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      points.forEach(function (point, index) {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = "#dfe9b9";
      ctx.lineWidth = 4;
      ctx.setLineDash([]);
      ctx.beginPath();
      points.forEach(function (point, index) {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.closePath();
      ctx.stroke();
      if (!$("#capturePage").hidden) requestAnimationFrame(drawGuide);
      return;
    }
    if (state.lastBox) {
      box = {
        x: state.lastBox.x / 360 * canvas.width,
        y: state.lastBox.y / Math.max(240, Math.round(360 * video.videoHeight / video.videoWidth)) * canvas.height,
        width: state.lastBox.width / 360 * canvas.width,
        height: state.lastBox.height / Math.max(240, Math.round(360 * video.videoHeight / video.videoWidth)) * canvas.height
      };
    }
    ctx.clearRect(box.x, box.y, box.width, box.height);
    ctx.strokeStyle = state.lastBox && state.lastBox.detected ? "#dfe9b9" : "rgba(255, 254, 249, .85)";
    ctx.lineWidth = 3;
    ctx.setLineDash([16, 10]);
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    ctx.setLineDash([]);
    if (!$("#capturePage").hidden) requestAnimationFrame(drawGuide);
  }

  function showCapture() {
    $("#capturePage").hidden = false;
    $("#reviewPage").hidden = true;
    requestAnimationFrame(drawGuide);
  }

  function showReview() {
    $("#capturePage").hidden = true;
    $("#reviewPage").hidden = false;
    render();
  }

  function updateStatus() {
    var count = state.pages.length;
    var status = "Локальний сканер";
    if (state.scannerStatus === "ready") status = "OpenCV готовий";
    if (state.scannerStatus === "fallback") status = "A4 fallback";
    $("#docStatus").textContent = count ? count + " стор. у документі" : status;
    document.documentElement.dataset.scanner = state.scannerStatus;
  }

  function render() {
    updateStatus();
    var hasPages = state.pages.length > 0;
    $("#emptyState").hidden = hasPages;
    $("#pagePreview").hidden = !hasPages;
    $("#previewImage").src = hasPages ? state.pages[state.selected].dataUrl : "";
    $("#cropLayer").hidden = !state.cropMode || !hasPages;
    $("#cropBtn").textContent = state.cropMode ? "Готово" : "Обрізати";
    if (state.cropMode && hasPages) requestAnimationFrame(drawCropBox);
    var list = $("#thumbList");
    list.innerHTML = "";
    state.pages.forEach(function (page, index) {
      var button = document.createElement("button");
      button.className = "thumb" + (index === state.selected ? " active" : "");
      button.type = "button";
      button.setAttribute("aria-label", "Сторінка " + (index + 1));
      button.dataset.index = String(index);
      var img = document.createElement("img");
      img.alt = "";
      img.src = page.dataUrl;
      button.appendChild(img);
      list.appendChild(button);
    });
    ["rotateBtn", "cropBtn", "deleteBtn", "shareBtn"].forEach(function (id) {
      $("#" + id).disabled = !hasPages;
    });
  }

  async function rotateSelected() {
    if (!state.pages.length) return;
    var page = state.pages[state.selected];
    var img = await dataUrlToImage(page.dataUrl);
    var canvas = $("#workCanvas");
    var ctx = canvas.getContext("2d");
    canvas.width = img.height;
    canvas.height = img.width;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
    page.dataUrl = await blobToDataUrl(await canvasToBlob(canvas, "image/jpeg", .88));
    await saveDocument();
    render();
  }

  async function recropSelected() {
    if (!state.pages.length) return;
    if (!state.cropMode) {
      enterCropMode();
      return;
    }
    if (state.cropRect) {
      await applyManualCrop();
      return;
    }
    var page = state.pages[state.selected];
    var img = await dataUrlToImage(page.dataUrl);
    state.pages[state.selected] = await processCanvas(captureToCanvas(img));
    state.pages[state.selected].id = page.id;
    state.cropMode = false;
    await saveDocument();
    render();
    toast("Обрізання оновлено.");
  }

  function enterCropMode() {
    state.cropMode = true;
    state.cropRect = null;
    state.cropStart = null;
    render();
    toast("Проведіть рамку по сторінці.");
  }

  function previewImageRect() {
    return $("#previewImage").getBoundingClientRect();
  }

  function normalizeRect(rect) {
    var x = Math.min(rect.x, rect.x2);
    var y = Math.min(rect.y, rect.y2);
    return {
      x: x,
      y: y,
      width: Math.abs(rect.x2 - rect.x),
      height: Math.abs(rect.y2 - rect.y)
    };
  }

  function pointInImage(event) {
    var image = previewImageRect();
    return {
      x: Math.max(0, Math.min(image.width, event.clientX - image.left)),
      y: Math.max(0, Math.min(image.height, event.clientY - image.top))
    };
  }

  function drawCropBox() {
    var box = $("#cropBox");
    var layer = $("#cropLayer");
    var image = previewImageRect();
    var layerRect = layer.getBoundingClientRect();
    var rect = state.cropRect || {
      x: image.width * .08,
      y: image.height * .08,
      width: image.width * .84,
      height: image.height * .84
    };
    box.style.left = (image.left - layerRect.left + rect.x) + "px";
    box.style.top = (image.top - layerRect.top + rect.y) + "px";
    box.style.width = rect.width + "px";
    box.style.height = rect.height + "px";
  }

  async function applyManualCrop() {
    var page = state.pages[state.selected];
    var img = await dataUrlToImage(page.dataUrl);
    var image = previewImageRect();
    var rect = state.cropRect;
    if (!rect || rect.width < 24 || rect.height < 24) {
      state.cropMode = false;
      state.cropRect = null;
      render();
      return;
    }
    var sx = Math.round(rect.x / image.width * img.width);
    var sy = Math.round(rect.y / image.height * img.height);
    var sw = Math.round(rect.width / image.width * img.width);
    var sh = Math.round(rect.height / image.height * img.height);
    var canvas = $("#workCanvas");
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    canvas.width = sw;
    canvas.height = sh;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    page.dataUrl = await blobToDataUrl(await canvasToBlob(canvas, "image/jpeg", .88));
    state.cropMode = false;
    state.cropRect = null;
    await saveDocument();
    render();
    toast("Обрізано.");
  }

  async function deleteSelected() {
    if (!state.pages.length) return;
    state.cropMode = false;
    state.cropRect = null;
    state.pages.splice(state.selected, 1);
    state.selected = Math.min(state.selected, Math.max(0, state.pages.length - 1));
    await saveDocument();
    render();
  }

  function escapePdfText(text) {
    return text.replace(/[()\\]/g, "\\$&");
  }

  function bytesFromString(text) {
    var bytes = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 255;
    return bytes;
  }

  function dataUrlToBytes(dataUrl) {
    var binary = atob(dataUrl.split(",")[1]);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function makePdfBlob() {
    var chunks = [];
    var offsets = [0];
    var position = 0;
    var objects = [];
    function add(textOrBytes) {
      var bytes = typeof textOrBytes === "string" ? bytesFromString(textOrBytes) : textOrBytes;
      chunks.push(bytes);
      position += bytes.length;
    }
    function object(id, bodyParts) {
      offsets[id] = position;
      add(id + " 0 obj\n");
      bodyParts.forEach(add);
      add("\nendobj\n");
    }
    add("%PDF-1.4\n");
    var pageIds = [];
    state.pages.forEach(function (page, index) {
      var imgId = 3 + index * 3;
      var contentId = imgId + 1;
      var pageId = imgId + 2;
      var bytes = dataUrlToBytes(page.dataUrl);
      var img = new Image();
      objects.push({ page: page, imgId: imgId, contentId: contentId, pageId: pageId, bytes: bytes, image: img });
      pageIds.push(pageId + " 0 R");
    });
    for (var i = 0; i < objects.length; i += 1) {
      objects[i].image = await dataUrlToImage(objects[i].page.dataUrl);
    }
    object(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
    object(2, ["<< /Type /Pages /Kids [", pageIds.join(" "), "] /Count ", String(pageIds.length), " >>"]);
    objects.forEach(function (item) {
      var w = item.image.width;
      var h = item.image.height;
      var pageW = 595;
      var pageH = Math.round(pageW * h / w);
      var content = "q\n" + pageW + " 0 0 " + pageH + " 0 0 cm\n/Im0 Do\nQ\n";
      object(item.imgId, [
        "<< /Type /XObject /Subtype /Image /Width ", String(w),
        " /Height ", String(h),
        " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ", String(item.bytes.length),
        " >>\nstream\n", item.bytes, "\nendstream"
      ]);
      object(item.contentId, [
        "<< /Length ", String(content.length), " >>\nstream\n", content, "endstream"
      ]);
      object(item.pageId, [
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ", String(pageW), " ", String(pageH),
        "] /Resources << /XObject << /Im0 ", String(item.imgId), " 0 R >> >> /Contents ",
        String(item.contentId), " 0 R >>"
      ]);
    });
    var xref = position;
    add("xref\n0 " + (objects.length * 3 + 3) + "\n0000000000 65535 f \n");
    for (var id = 1; id <= objects.length * 3 + 2; id += 1) {
      add(String(offsets[id]).padStart(10, "0") + " 00000 n \n");
    }
    add("trailer\n<< /Size " + (objects.length * 3 + 3) + " /Root 1 0 R /Info << /Title (" + escapePdfText("НА-СКАНІ") + ") >> >>\nstartxref\n" + xref + "\n%%EOF");
    return new Blob(chunks, { type: "application/pdf" });
  }

  async function shareDocument() {
    if (!state.pages.length) return;
    var blob = await makePdfBlob();
    var file = new File([blob], "na-scani.pdf", { type: "application/pdf" });
    if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
      await navigator.share({
        files: [file],
        title: "НА-СКАНІ",
        text: "Скан документа"
      });
      return;
    }
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "na-scani.pdf";
    link.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    toast("PDF збережено.");
  }

  async function newDocument() {
    if (state.pages.length && !confirm("Очистити поточний документ?")) return;
    state.pages = [];
    state.selected = 0;
    await saveDocument();
    render();
    showCapture();
  }

  async function runTestPhotoIfNeeded() {
    var params = new URLSearchParams(window.location.search);
    if (!params.has("testPhoto")) return;
    var img = await dataUrlToImage("фото%20на%20тест/IMG_0094.jpeg");
    state.pages = [];
    state.selected = 0;
    await addScanFromSource(img);
    showReview();
  }

  function bindEvents() {
    $("#scanBtn").addEventListener("click", function () {
      var video = $("#camera");
      if (!video.videoWidth) {
        toast("Камера ще не готова.");
        return;
      }
      addScanFromSource(video).then(showReview).catch(function () {
        toast("Не вдалося зробити скан.");
      });
    });
    $("#pickBtn").addEventListener("click", function () {
      $("#fileInput").click();
    });
    $("#fileInput").addEventListener("change", async function (event) {
      var file = event.target.files && event.target.files[0];
      event.target.value = "";
      if (!file) return;
      var img = await dataUrlToImage(await blobToDataUrl(file));
      await addScanFromSource(img);
      showReview();
    });
    $("#finishBtn").addEventListener("click", showReview);
    $("#backToCameraBtn").addEventListener("click", showCapture);
    $("#rotateBtn").addEventListener("click", rotateSelected);
    $("#cropBtn").addEventListener("click", recropSelected);
    $("#deleteBtn").addEventListener("click", deleteSelected);
    $("#shareBtn").addEventListener("click", function () {
      shareDocument().catch(function () { toast("Поділитись не вдалося."); });
    });
    $("#newDocBtn").addEventListener("click", newDocument);
    $("#thumbList").addEventListener("click", function (event) {
      var button = event.target.closest(".thumb");
      if (!button) return;
      state.cropMode = false;
      state.cropRect = null;
      state.selected = Number(button.dataset.index);
      saveDocument();
      render();
    });
    $("#cropLayer").addEventListener("pointerdown", function (event) {
      if (!state.cropMode) return;
      var point = pointInImage(event);
      state.cropStart = point;
      state.cropRect = { x: point.x, y: point.y, width: 1, height: 1 };
      $("#cropLayer").setPointerCapture(event.pointerId);
      drawCropBox();
    });
    $("#cropLayer").addEventListener("pointermove", function (event) {
      if (!state.cropMode || !state.cropStart) return;
      var point = pointInImage(event);
      state.cropRect = normalizeRect({ x: state.cropStart.x, y: state.cropStart.y, x2: point.x, y2: point.y });
      drawCropBox();
    });
    $("#cropLayer").addEventListener("pointerup", function () {
      state.cropStart = null;
      drawCropBox();
    });
    document.querySelectorAll(".mode-btn").forEach(function (button) {
      button.addEventListener("click", function () {
        document.querySelectorAll(".mode-btn").forEach(function (item) { item.classList.remove("active"); });
        button.classList.add("active");
        state.mode = button.dataset.mode;
      });
    });
  }

  async function init() {
    bindEvents();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    }
    prepareScanner().then(function (ready) {
      state.scannerStatus = ready ? "ready" : "fallback";
      updateStatus();
      if (ready) toast("OpenCV сканер готовий.");
      runTestPhotoIfNeeded().catch(function () {
        toast("Тестове фото не обробилось.");
      });
    });
    await openDb();
    await loadDocument();
    render();
    await startCamera();
    if (state.pages.length) showReview();
  }

  init().catch(function () {
    toast("Застосунок запустився без локального сховища.");
    startCamera();
  });
}());
