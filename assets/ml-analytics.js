/* ============================================
   ML Analytics - Smart Tracking Library v2.0
   MIGRATED TO POSTHOG CLOUD

   Changes from v1:
   - Internal events now sent to PostHog Cloud (posthog.capture)
   - NO MORE requests to /api/event.php (eliminates PHP worker load)
   - NO MORE tracking pixel to /api/track.php (eliminated separately)
   - Facebook Pixel + CAPI dedup: UNCHANGED
   - TikTok Pixel + Events API dedup: UNCHANGED
   - Session tracking, ttclid capture: UNCHANGED
   - Public API: 100% backward-compatible (zero breaking changes)
   ============================================ */

var MLA = (function() {
  'use strict';

  // ╔══════════════════════════════════════════════════╗
  // ║  POSTHOG CONFIG — Cole sua API key aqui          ║
  // ╚══════════════════════════════════════════════════╝
  var POSTHOG_API_KEY = 'phc_AjtNo7WcPDHt2By14rADXptDtLTTURcVNlO77lLjYeq';
  var POSTHOG_HOST    = 'https://us.i.posthog.com';

  // ── Load PostHog JS SDK from CDN ──
  (function loadPostHog(d, w) {
    if (w.posthog) return; // Already loaded
    var ph = w.posthog = [];
    ph._i = [];
    ph.init = function(key, cfg, name) {
      function proxy(obj, method) {
        var parts = method.split('.');
        if (parts.length === 2) { obj = obj[parts[0]]; method = parts[1]; }
        obj[method] = function() { obj.push([method].concat(Array.prototype.slice.call(arguments, 0))); };
      }
      var s = d.createElement('script');
      s.type = 'text/javascript';
      s.crossOrigin = 'anonymous';
      s.async = true;
      s.src = cfg.api_host + '/static/array.js';
      var first = d.getElementsByTagName('script')[0];
      first.parentNode.insertBefore(s, first);
      var u = ph;
      if (name !== undefined) { u = ph[name] = []; } else { name = 'posthog'; }
      u.people = u.people || [];
      u.toString = function(n) { var e = 'posthog'; if (name !== 'posthog') e += '.' + name; if (!n) e += ' (stub)'; return e; };
      u.people.toString = function() { return u.toString(1) + '.people (stub)'; };
      var methods = 'init capture register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group identify setPersonProperties setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags'.split(' ');
      for (var i = 0; i < methods.length; i++) proxy(u, methods[i]);
      ph._i.push([key, cfg, name]);
    };
    ph.__SV = 1;
  })(document, window);

  // Initialize PostHog — autocapture pageviews replaces track.php pixel
  if (POSTHOG_API_KEY !== 'COLE_SUA_API_KEY_POSTHOG_AQUI') {
    posthog.init(POSTHOG_API_KEY, {
      api_host: POSTHOG_HOST,
      person_profiles: 'identified_only',
      autocapture: false,          // We send events manually
      capture_pageview: true,      // Replaces track.php pixel
      capture_pageleave: true,     // Bonus: time-on-page data
      persistence: 'localStorage',
      loaded: function(ph) {
        // Register super properties so they appear on every event
        ph.register({
          ml_session_id: sessionId,
          funnel_stage: getFunnelStage(),
          page_name: getPageName()
        });
      }
    });
  }

  window.posthog = posthog;

  // ── Session ID: persist per browser session ──
  var SESSION_KEY = 'ml_session_id';
  var sessionId = sessionStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = 'ses_' + Date.now() + '_' + rand(8);
    sessionStorage.setItem(SESSION_KEY, sessionId);
  }

  // ── Debug mode ──
  var DEBUG = (window.location.search.indexOf('ml_debug=1') !== -1);
  if (DEBUG) {
    try { localStorage.setItem('ml_debug', '1'); } catch(e) {}
  } else {
    try { DEBUG = localStorage.getItem('ml_debug') === '1'; } catch(e) {}
  }

  // ── Capture ttclid (TikTok Click ID) ──
  (function captureTTClid() {
    var params = new URLSearchParams(window.location.search);
    var ttclid = params.get('ttclid');
    if (ttclid) {
      try {
        localStorage.setItem('ml_ttclid', ttclid);
        // Also set as cookie for pixel auto-read
        document.cookie = 'ttclid=' + ttclid + '; max-age=2592000; path=/; SameSite=Lax';
      } catch(e) {}
    }
  })();

  // ── Helpers ──
  function rand(len) {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var s = '';
    for (var i = 0; i < len; i++) {
      s += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return s;
  }

  function generateEventId(prefix) {
    // UUID-like: prefix_timestamp_random
    prefix = prefix || 'evt';
    return prefix + '_' + Date.now() + '_' + rand(8);
  }

  function log() {
    if (DEBUG && console && console.log) {
      var args = ['[MLA]'].concat(Array.prototype.slice.call(arguments));
      console.log.apply(console, args);
    }
  }

  function getPageName() {
  var path = window.location.pathname || '/';

  if (path === '/' || path === '/index.html') return 'home';
  if (path.indexOf('/rewards') !== -1) return 'rewards';

  // fallback legado
  if (path.indexOf('/prevsl') !== -1) return 'prevsl';
  if (path.indexOf('/vsl') !== -1) return 'vsl';
  if (path.indexOf('/questionario') !== -1) return 'questionario';
  if (path.indexOf('/roleta') !== -1) return 'roleta';
  if (path.indexOf('/recompensas') !== -1) return 'recompensas';
  if (path.indexOf('/checkout') !== -1) return 'checkout';
  if (path.indexOf('/up') !== -1) return 'upsell';

  return path;
}

function getFunnelStage() {
  var stages = {
    home: 1,
    rewards: 2,
    recompensas: 2,
    checkout: 3,
    upsell: 4
  };

  var page = getPageName();
  return stages[page] || 0;
}

  function getStoredUTMs() {
    try {
      return JSON.parse(localStorage.getItem('ml_utms') || '{}');
    } catch(e) { return {}; }
  }

  function getStoredFBP() {
    // Try cookie first, then localStorage
    var match = document.cookie.match(/(?:^|;\s*)_fbp=([^;]*)/);
    if (match) return match[1];
    return localStorage.getItem('ml_fbp') || null;
  }

  function getStoredFBC() {
    var match = document.cookie.match(/(?:^|;\s*)_fbc=([^;]*)/);
    if (match) return match[1];
    return localStorage.getItem('ml_fbc') || null;
  }

  function getStoredTTClid() {
    return localStorage.getItem('ml_ttclid') || null;
  }

  // ── Track internal analytics event → POSTHOG ──
  function track(eventName, data) {
    data = data || {};

    var props = {
      session_id: sessionId,
      page: getPageName(),
      funnel_stage: getFunnelStage(),
      page_url: window.location.href,
      page_referrer: document.referrer || '',
      client_timestamp: new Date().toISOString(),
      experiment_id: (window.__ML_EXPERIMENT && window.__ML_EXPERIMENT.id) ? window.__ML_EXPERIMENT.id : null,
      variant_id: (window.__ML_EXPERIMENT && window.__ML_EXPERIMENT.variant) ? window.__ML_EXPERIMENT.variant : null
    };

    // Merge UTMs as flat properties
    var utms = getStoredUTMs();
    if (utms) {
      for (var uk in utms) {
        if (utms.hasOwnProperty(uk)) props['utm_' + uk.replace('utm_', '')] = utms[uk];
      }
    }

    // Merge custom data as flat properties (prefixed with "d_" to avoid collisions)
    for (var dk in data) {
      if (data.hasOwnProperty(dk)) props[dk] = data[dk];
    }

    log('track:', eventName, props);

    // ── Send to PostHog instead of /api/event.php ──
    try {
      if (window.location.protocol === 'file:') {
        log('SKIP (file:// protocol)');
        return;
      }
      if (typeof posthog !== 'undefined' && posthog.capture) {
        posthog.capture(eventName, props);
      } else {
        log('PostHog not loaded, event queued internally');
      }
    } catch(e) {
      log('track error:', e);
    }
  }

  // ── Facebook Pixel with dedup ──
  function fbTrack(eventName, customData, eventId) {
    if (typeof fbq !== 'function') {
      log('FB Pixel not loaded, skip:', eventName);
      return eventId;
    }
    eventId = eventId || generateEventId('fb');

    var opts = { eventID: eventId };

    if (eventName === 'PageView') {
      // PageView is auto-tracked, but we can fire it explicitly
      fbq('track', 'PageView', {}, opts);
    } else {
      fbq('track', eventName, customData || {}, opts);
    }

    log('FB Pixel:', eventName, 'eventID:', eventId, customData);
    return eventId;
  }

  // ── Facebook Custom Event with dedup ──
  function fbTrackCustom(eventName, customData, eventId) {
    if (typeof fbq !== 'function') {
      log('FB Pixel not loaded, skip custom:', eventName);
      return eventId;
    }
    eventId = eventId || generateEventId('fb');
    fbq('trackCustom', eventName, customData || {}, { eventID: eventId });
    log('FB Custom:', eventName, 'eventID:', eventId, customData);
    return eventId;
  }

  // ── TikTok Pixel with dedup ──
  function ttTrack(eventName, properties, eventId) {
    if (typeof ttq === 'undefined') {
      log('TikTok Pixel not loaded, skip:', eventName);
      return eventId;
    }
    eventId = eventId || generateEventId('tt');

    var opts = {
      event_id: eventId
    };

    // Merge properties
    var data = {};
    if (properties) {
      for (var key in properties) {
        if (properties.hasOwnProperty(key)) {
          data[key] = properties[key];
        }
      }
    }

    ttq.track(eventName, data, opts);
    log('TT Pixel:', eventName, 'event_id:', eventId, data);
    return eventId;
  }

  // ── Combined: Fire both FB + TT + internal analytics ──
  function fireEvent(eventName, opts) {
    opts = opts || {};
    var eventId = opts.eventId || generateEventId(eventName.toLowerCase().replace(/[^a-z]/g, ''));

    // Internal analytics → PostHog
    var analyticsData = opts.analyticsData || {};
    analyticsData.event_id = eventId;
    track(eventName, analyticsData);

    // Facebook Pixel
    if (opts.fb !== false) {
      var fbData = opts.fbData || opts.customData || {};
      if (opts.fbCustom) {
        fbTrackCustom(eventName, fbData, eventId);
      } else {
        fbTrack(opts.fbEventName || eventName, fbData, eventId);
      }
    }

    // TikTok Pixel
    if (opts.tt !== false) {
      var ttData = opts.ttData || opts.customData || {};
      ttTrack(opts.ttEventName || eventName, ttData, eventId);
    }

    return eventId;
  }

  // ── Specific funnel events ──

  // ViewContent: product page
  function trackViewContent(product) {
    var eventId = generateEventId('vc');
    var value = (product.price || 0) / 100;

    track('ViewContent', {
      event_id: eventId,
      product_id: product.id,
      product_name: product.name,
      value: value
    });

    fbTrack('ViewContent', {
      content_ids: [product.id],
      content_name: product.name,
      content_type: 'product',
      value: value,
      currency: 'BRL'
    }, eventId);

    ttTrack('ViewContent', {
      content_id: product.id,
      content_name: product.name,
      content_type: 'product',
      value: value,
      currency: 'BRL'
    }, eventId);

    return eventId;
  }

  // AddToCart: product page
  function trackAddToCart(product) {
    var eventId = generateEventId('atc');
    var value = (product.price || 0) / 100;

    track('AddToCart', {
      event_id: eventId,
      product_id: product.id,
      product_name: product.name,
      value: value
    });

    fbTrack('AddToCart', {
      content_ids: [product.id],
      content_name: product.name,
      content_type: 'product',
      value: value,
      currency: 'BRL'
    }, eventId);

    ttTrack('AddToCart', {
      content_id: product.id,
      content_name: product.name,
      content_type: 'product',
      value: value,
      currency: 'BRL'
    }, eventId);

    return eventId;
  }

  // InitiateCheckout: checkout page load (step 1)
  function trackInitiateCheckout(items, totalValue) {
    var eventId = generateEventId('ic');
    var value = (totalValue || 0) / 100;
    var contentIds = items.map(function(i) { return i.id; });

    track('InitiateCheckout', {
      event_id: eventId,
      num_items: items.length,
      value: value,
      content_ids: contentIds
    });

    fbTrack('InitiateCheckout', {
      content_ids: contentIds,
      content_type: 'product',
      num_items: items.length,
      value: value,
      currency: 'BRL'
    }, eventId);

    ttTrack('InitiateCheckout', {
      content_type: 'product',
      content_id: contentIds.join(','),
      quantity: items.length,
      value: value,
      currency: 'BRL'
    }, eventId);

    return eventId;
  }

  // AddPaymentInfo: checkout step 5 (confirm)
  function trackAddPaymentInfo(items, totalValue) {
    var eventId = generateEventId('api');
    var value = (totalValue || 0) / 100;

    track('AddPaymentInfo', {
      event_id: eventId,
      payment_method: 'pix',
      value: value,
      num_items: items.length
    });

    fbTrack('AddPaymentInfo', {
      content_type: 'product',
      value: value,
      currency: 'BRL',
      content_ids: items.map(function(i) { return i.id; })
    }, eventId);

    ttTrack('AddPaymentInfo', {
      content_type: 'product',
      value: value,
      currency: 'BRL',
      description: 'PIX'
    }, eventId);

    return eventId;
  }

  // GeneratePixCode: custom event when QR appears
  function trackGeneratePixCode(paymentCode, totalValue, items) {
    var eventId = generateEventId('gpx');
    var value = (totalValue || 0) / 100;

    track('GeneratePixCode', {
      event_id: eventId,
      payment_code: paymentCode,
      value: value,
      num_items: (items || []).length
    });

    fbTrackCustom('GeneratePixCode', {
      value: value,
      currency: 'BRL',
      payment_method: 'pix',
      order_id: paymentCode,
      content_type: 'product',
      content_ids: (items || []).map(function(i) { return i.id; })
    }, eventId);

    // TikTok custom event
    ttTrack('GeneratePixCode', {
      value: value,
      currency: 'BRL',
      order_id: paymentCode,
      description: 'PIX QR Code Generated'
    }, eventId);

    return eventId;
  }

  // CopyPixCode: custom event when user copies PIX code
  function trackCopyPixCode(paymentCode) {
    var eventId = generateEventId('cpx');

    track('CopyPixCode', {
      event_id: eventId,
      payment_code: paymentCode
    });

    // Only browser-side (no server visibility)
    fbTrackCustom('CopyPixCode', {
      payment_method: 'pix',
      order_id: paymentCode
    }, eventId);

    ttTrack('ClickButton', {
      description: 'Copy PIX Code',
      order_id: paymentCode
    }, eventId);

    return eventId;
  }

  // Purchase: when payment confirmed on client
  // IMPORTANT: event_id MUST match server-side (fireApprovalTracking) for dedup
  function trackPurchase(paymentCode, totalValue, items) {
    var eventId = 'pur_' + paymentCode;
    var value = (totalValue || 0) / 100;
    var contentIds = (items || []).map(function(i) { return i.id; });

    track('Purchase', {
      event_id: eventId,
      payment_code: paymentCode,
      value: value,
      num_items: (items || []).length
    });

    fbTrack('Purchase', {
      value: value,
      currency: 'BRL',
      content_ids: contentIds,
      content_type: 'product',
      order_id: paymentCode
    }, eventId);

    ttTrack('CompletePayment', {
      content_type: 'product',
      content_id: contentIds.join(','),
      quantity: (items || []).reduce(function(sum, i) { return sum + (i.quantity || 1); }, 0),
      value: value,
      currency: 'BRL'
    }, eventId);

    return eventId;
  }

  // Checkout step tracking
  function trackCheckoutStep(step, stepName) {
    track('checkout_step', {
      step: step,
      step_name: stepName || ('step_' + step)
    });
  }

  // Form error tracking
  function trackFormError(field, message) {
    track('form_error', {
      field: field,
      message: message
    });
  }

  // Funnel page view
  function trackFunnelView(page) {
    track('funnel_view', {
      page: page || getPageName(),
      funnel_stage: getFunnelStage()
    });
  }

  // ── Auto-track funnel page view on load ──
  document.addEventListener('DOMContentLoaded', function() {
    trackFunnelView();

    // Set PostHog super properties now that DOM is ready
    if (typeof posthog !== 'undefined' && posthog.register) {
      posthog.register({
        ml_session_id: sessionId,
        funnel_stage: getFunnelStage(),
        page_name: getPageName()
      });
    }
  });

  // ── Public API ──
  return {
    // Core
    track: track,
    fbTrack: fbTrack,
    fbTrackCustom: fbTrackCustom,
    ttTrack: ttTrack,
    fireEvent: fireEvent,
    generateEventId: generateEventId,

    // Specific funnel events
    trackViewContent: trackViewContent,
    trackAddToCart: trackAddToCart,
    trackInitiateCheckout: trackInitiateCheckout,
    trackAddPaymentInfo: trackAddPaymentInfo,
    trackGeneratePixCode: trackGeneratePixCode,
    trackCopyPixCode: trackCopyPixCode,
    trackPurchase: trackPurchase,
    trackCheckoutStep: trackCheckoutStep,
    trackFormError: trackFormError,
    trackFunnelView: trackFunnelView,

    // Utilities
    getSessionId: function() { return sessionId; },
    getPageName: getPageName,
    getFunnelStage: getFunnelStage,
    getStoredFBP: getStoredFBP,
    getStoredFBC: getStoredFBC,
    getStoredTTClid: getStoredTTClid,
    getStoredUTMs: getStoredUTMs,
    isDebug: function() { return DEBUG; }
  };

})();
