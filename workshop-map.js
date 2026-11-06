/* workshop-map.js — Google Maps for Workshop pages (Market Update's CMA, Hold an Open House).
   Loads Google's script once, only when a page first needs a map, so opening a page
   without using its map costs nothing. Needs auth.js and a signed-in user: the key comes
   from the server (GET /maps/config, server/maps-routes.js), so it isn't in this repo or
   on a public page. It's restricted to johnadams.org and the Maps JavaScript service,
   so maps don't work on localhost.

     await WorkshopMap.load();                   // rejects if the map can't be used
     const map = WorkshopMap.create(element, { center: { lat, lng } });
     WorkshopMap.onFailure(() => { ...hide the map... });
*/
(function () {
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
    loading = (async () => {
      const { browserKey } = await Auth.api('/maps/config');
      if (!browserKey) throw new Error('the map is not set up');
      await new Promise((resolve, reject) => {
        window.__workshopMapReady = async () => {
          try {
            await Promise.all([google.maps.importLibrary('maps'), google.maps.importLibrary('marker')]);
            resolve();
          } catch (e) { reject(e); }
        };
        const s = document.createElement('script');
        s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(browserKey)}&v=weekly&loading=async&callback=__workshopMapReady`;
        s.async = true;
        s.onerror = () => reject(new Error("couldn't load Google Maps"));
        document.head.appendChild(s);
      });
      return google.maps;
    })().catch(e => { fail(); throw e; });
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
    load, create, fit,
    onFailure(fn) { if (failed) fn(); else listeners.push(fn); },
    get failed() { return failed; },
  };
})();
