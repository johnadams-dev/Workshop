/* workshop-map.js — Google Maps for Workshop pages (Market Update's CMA, Hold an Open House).
   Loads Google's script once, only when a page first needs a map, so opening a page
   without using its map costs nothing.

   The key belongs in the page: a browser key always does. It's restricted to
   johnadams.org and to the Maps JavaScript and Maps Static services (Cloud project
   mls-data-sync, key "Workshop Maps (browser)"), so it won't work from anywhere else —
   including localhost.

     await WorkshopMap.load();                   // rejects if the map can't be used
     const map = WorkshopMap.create(element, { center: { lat, lng } });
     WorkshopMap.onFailure(() => { ...hide the map... });
*/
(function () {
  const KEY = 'AIzaSyBcAM4h9sSW8B1xJnPHnisEfdwHar75otQ';
  let loading = null;
  let failed = false;
  const listeners = [];

  function fail() {
    failed = true;
    listeners.splice(0).forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  }
  // Google calls this when it refuses the key (wrong site, service off, billing)
  window.gm_authFailure = fail;

  function load() {
    if (failed) return Promise.reject(new Error('map unavailable'));
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      window.__workshopMapReady = async () => {
        try {
          await Promise.all([google.maps.importLibrary('maps'), google.maps.importLibrary('marker')]);
          resolve(google.maps);
        } catch (e) { fail(); reject(e); }
      };
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${KEY}&v=weekly&loading=async&callback=__workshopMapReady`;
      s.async = true;
      s.onerror = () => { fail(); reject(new Error("couldn't load Google Maps")); };
      document.head.appendChild(s);
    });
    return loading;
  }

  function create(el, options) {
    return new google.maps.Map(el, Object.assign({
      zoom: 12, mapTypeControl: false, streetViewControl: false, fullscreenControl: true,
      clickableIcons: false, gestureHandling: 'cooperative',
    }, options));
  }

  // Fit the map to [{ lat, lng }, …]; a single point gets a sensible zoom
  function fit(map, points) {
    if (!points.length) return;
    if (points.length === 1) { map.setCenter(points[0]); map.setZoom(15); return; }
    const b = new google.maps.LatLngBounds();
    points.forEach(p => b.extend(p));
    map.fitBounds(b, 40);
  }

  window.WorkshopMap = {
    KEY, load, create, fit,
    onFailure(fn) { if (failed) fn(); else listeners.push(fn); },
    get failed() { return failed; },
  };
})();
