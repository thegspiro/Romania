/**
 * Places, drawn with Leaflet.
 *
 * Progressive enhancement, like graph.js. A place page already prints its
 * coordinates in the details list, and the overview page carries the same set
 * as a linked list beneath the canvas, so nothing is lost when this does not
 * run: the container stays empty and the status line explains why.
 *
 * The server has already applied the visibility rule, so whatever arrives here
 * is drawable as-is. This script never asks for anything it was not given a
 * URL for, and there is no request to any third party unless the operator
 * configured a tile host -- with none, the markers draw on a plain background
 * and the browser talks only to this server.
 */
(function () {
  'use strict';

  var single = document.getElementById('place-map');
  var many = document.getElementById('places-map');
  var container = single || many;
  if (!container) return;

  var status = document.getElementById(single ? 'place-map-status' : 'places-map-status');

  function say(message) {
    if (status) status.textContent = message;
  }

  if (typeof window.L !== 'object' || !window.L || typeof window.L.map !== 'function') {
    say('The map could not load its library. The coordinates are listed above.');
    return;
  }

  var L = window.L;

  // Leaflet resolves its default marker icons against a CDN-shaped path that
  // assumes the images sit beside the script. They are vendored alongside it,
  // so pointing at them explicitly keeps every request on this origin.
  var icon = L.icon({
    iconUrl: '/assets/vendor/leaflet/images/marker-icon.png',
    iconRetinaUrl: '/assets/vendor/leaflet/images/marker-icon-2x.png',
    shadowUrl: '/assets/vendor/leaflet/images/marker-shadow.png',
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
    shadowSize: [41, 41],
  });

  var map = L.map(container, { scrollWheelZoom: false });

  var tileUrl = container.getAttribute('data-tile-url');
  if (tileUrl) {
    L.tileLayer(tileUrl, {
      attribution: container.getAttribute('data-tile-attribution') || '',
      maxZoom: 18,
    }).addTo(map);
  }

  // Without a basemap there is no scale to read the markers against, so the
  // scale bar is the one thing that makes a bare canvas interpretable.
  L.control.scale({ imperial: false }).addTo(map);

  function label(title, precision) {
    var wording =
      precision === 'exact'
        ? 'located exactly'
        : precision === 'approximate'
          ? 'located approximately'
          : precision === 'region'
            ? 'located to a region'
            : 'precision unrecorded';
    // textContent, never innerHTML: a place title is operator text and this is
    // the one place in this file that could turn it into markup.
    var wrapper = document.createElement('div');
    var name = document.createElement('strong');
    name.textContent = title;
    var note = document.createElement('div');
    note.className = 'muted small';
    note.textContent = wording;
    wrapper.appendChild(name);
    wrapper.appendChild(note);
    return wrapper;
  }

  function drawOne() {
    var latitude = Number(container.getAttribute('data-latitude'));
    var longitude = Number(container.getAttribute('data-longitude'));
    if (!isFinite(latitude) || !isFinite(longitude)) {
      say('This place has no usable coordinates.');
      return;
    }

    map.setView([latitude, longitude], 11);
    L.marker([latitude, longitude], { icon: icon })
      .addTo(map)
      .bindPopup(
        label(
          container.getAttribute('data-title') || '',
          container.getAttribute('data-precision') || 'unknown',
        ),
      );
    say('');
  }

  function drawMany() {
    var url = container.getAttribute('data-places-url');
    if (!url) return;

    say('Loading places…');

    fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (response) {
        if (!response.ok) throw new Error('Request failed: ' + response.status);
        return response.json();
      })
      .then(function (data) {
        var places = (data && data.places) || [];
        if (places.length === 0) {
          say('No places have coordinates yet.');
          return;
        }

        var bounds = [];
        places.forEach(function (place) {
          var latitude = Number(place.latitude);
          var longitude = Number(place.longitude);
          if (!isFinite(latitude) || !isFinite(longitude)) return;

          var marker = L.marker([latitude, longitude], { icon: icon }).addTo(map);
          var popup = label(place.title, place.precision);

          // The marker links back to the place's own page, which is where the
          // rest of the record lives.
          if (place.href) {
            var link = document.createElement('a');
            link.href = place.href;
            link.textContent = 'Open this place';
            popup.appendChild(link);
          }
          marker.bindPopup(popup);
          bounds.push([latitude, longitude]);
        });

        if (bounds.length === 1) map.setView(bounds[0], 9);
        else if (bounds.length > 1) map.fitBounds(bounds, { padding: [24, 24] });

        say('');
      })
      .catch(function () {
        say('The map could not load its places. The list below has the same set.');
      });
  }

  if (single) drawOne();
  else drawMany();
})();
