/**
 * The relationship network, drawn with Cytoscape.
 *
 * Progressive enhancement: the mentions and relationships lists above the
 * canvas carry the same information as text, so nothing is lost when this does
 * not run. The container stays empty and a short status line explains why.
 *
 * The server has already applied the visibility rule at every hop, so whatever
 * arrives here is drawable as-is.
 */
(function () {
  'use strict';

  var container = document.getElementById('relationship-graph');
  var status = document.getElementById('graph-status');
  if (!container) return;

  function say(message) {
    if (status) status.textContent = message;
  }

  if (typeof window.cytoscape !== 'function') {
    say('The network view could not load its library.');
    return;
  }

  var url = container.getAttribute('data-graph-url');
  if (!url) return;

  say('Loading connections…');

  fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(function (response) {
      if (!response.ok) throw new Error('Could not load connections (' + response.status + ').');
      return response.json();
    })
    .then(function (graph) {
      if (!graph.nodes || graph.nodes.length <= 1) {
        say(
          graph.year
            ? 'No connections recorded for ' + graph.year + '.'
            : 'No connections recorded yet.',
        );
        return;
      }

      var elements = [];

      graph.nodes.forEach(function (node) {
        elements.push({
          data: {
            id: String(node.id),
            label: node.title,
            href: node.href,
            kind: node.kind,
            centre: node.distance === 0 ? 'yes' : 'no',
          },
        });
      });

      graph.edges.forEach(function (edge, index) {
        elements.push({
          data: {
            id: 'e' + index,
            source: String(edge.source),
            target: String(edge.target),
            // The server folded the office and the period into `display`,
            // so the drawing and the list above it read the same way.
            label: edge.display || edge.label,
            relation: edge.relation,
          },
        });
      });

      var cy = window.cytoscape({
        container: container,
        elements: elements,
        // Colours are read from the stylesheet's custom properties so the
        // drawing matches the rest of the site in one place.
        style: [
          {
            selector: 'node',
            style: {
              'background-color': '#7a2e2e',
              label: 'data(label)',
              'font-size': '11px',
              'font-family': 'system-ui, sans-serif',
              color: '#1a1a1a',
              'text-valign': 'bottom',
              'text-margin-y': 4,
              'text-wrap': 'ellipsis',
              'text-max-width': '120px',
              width: 18,
              height: 18,
            },
          },
          {
            selector: 'node[centre = "yes"]',
            style: { 'background-color': '#1a1a1a', width: 26, height: 26, 'font-weight': 'bold' },
          },
          {
            selector: 'edge',
            style: {
              width: 1.5,
              'line-color': '#d8d4cc',
              'target-arrow-color': '#d8d4cc',
              'target-arrow-shape': 'triangle',
              'curve-style': 'bezier',
              label: 'data(label)',
              'font-size': '9px',
              color: '#5c5c5c',
              'text-rotation': 'autorotate',
              'text-background-color': '#fdfdfb',
              'text-background-opacity': 1,
              'text-background-padding': 2,
            },
          },
          {
            // Mentions are inferred from prose; relationships were asserted.
            // They are drawn differently because they mean different things.
            selector: 'edge[relation = "mentioned"]',
            style: { 'line-style': 'dashed', 'line-color': '#c9c4ba' },
          },
        ],
        layout: { name: 'cose', animate: false, padding: 20, nodeRepulsion: 6000 },
        minZoom: 0.2,
        maxZoom: 2.5,
      });

      cy.on('tap', 'node', function (event) {
        var href = event.target.data('href');
        if (href) window.location.assign(href);
      });

      say(
        graph.nodes.length -
          1 +
          ' connected item' +
          (graph.nodes.length === 2 ? '' : 's') +
          (graph.truncated ? ' (showing the closest ones)' : '') +
          '. Select a node to open its page.',
      );
    })
    .catch(function (error) {
      say(error.message);
    });
})();
