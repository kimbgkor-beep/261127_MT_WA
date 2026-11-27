"""Flask web application for responsive railway hazard-weather monitoring."""

import os

from flask import Flask, jsonify, render_template

from geo_service import generate_hazard_zones, generate_rainfall, get_network_data

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "templates"),
    static_folder=os.path.join(BASE_DIR, "static"),
)


@app.route("/")
def index():
    """Render the responsive monitoring dashboard."""
    return render_template("index.html")


@app.route("/api/network")
def api_network():
    """Return railway routes, 5km buffers, AWS stations, and initial weather/zones."""
    network = get_network_data()
    return jsonify(
        {
            **network,
            "zones": generate_hazard_zones(network["paths"]),
            "rainfall": generate_rainfall(network["stations"]),
        }
    )


@app.route("/api/zones")
def api_zones():
    """Regenerate and return simulated hazard weather zones."""
    network = get_network_data()
    return jsonify({"zones": generate_hazard_zones(network["paths"])})


@app.route("/api/rainfall")
def api_rainfall():
    """Regenerate and return simulated hourly rainfall readings."""
    network = get_network_data()
    return jsonify({"rainfall": generate_rainfall(network["stations"])})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=True)
