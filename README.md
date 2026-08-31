# Delivery Time Prediction & Fleet Resource Allocation System

A Render-ready Flask web application for delivery ETA prediction, fleet allocation, route mapping, user accounts and an embedded FleetAI assistant.

## Features
- Public landing page
- User registration/login
- One global administrator provisioned only through Render environment variables
- Admin account cannot be created or duplicated through the UI
- Delivery-time prediction from distance, traffic, weather and priority
- Fleet allocation based on availability/capacity/type
- Interactive Leaflet + OpenStreetMap map
- User delivery history and live dashboard
- Admin fleet/user/order management
- FleetAI chatbot
- SQLite local development database
- Render/GitHub ready

## Run locally
Python 3.13 recommended.

    python -m venv .venv
    # Windows:
    .venv\Scripts\activate
    # macOS/Linux:
    source .venv/bin/activate
    pip install -r requirements.txt

Set environment variables from `.env.example`, then:

    python app.py

Open http://127.0.0.1:5000

## Render
Create a Web Service connected to GitHub. Render can build with:
Build: `pip install -r requirements.txt`
Start: `gunicorn app:app`

Set these Render environment variables:
- SECRET_KEY (generate a secure value)
- ADMIN_EMAIL (keep private)
- ADMIN_PASSWORD (keep private)

Do NOT put administrator credentials into source code, README, screenshots, GitHub, or frontend JavaScript.

## Map
The UI uses Leaflet and OpenStreetMap tiles for the interactive map. If you add public geocoding later, respect provider policies, rate limits and attribution. For production/high traffic, use a suitable geocoding provider or self-hosted service.

## Important persistence note
SQLite is ideal for local/demo use. On Render, use a managed PostgreSQL database for production persistence; the current app keeps the schema simple so it can be migrated later.


## Development Team — Mohan Babu University
- K Venkata Raviteja — Project Lead & System Architect — 23102A030210
- P Charan Kumar — AI/ML & Data Lead — 23102A030232
- M Chanikya — Frontend & Map Experience — 23102A030233
- Rahul Krishna — Backend & Database Engineer — 23102A030212
- J Eswar — QA, DevOps & Deployment — 23102A030199

The Developers page is publicly viewable at `/developers`.


## Real-Time Order Tracking Upgrade
- FleetAI is now a floating assistant modal; it opens only after the user clicks the FleetAI button.
- Dashboard navigation includes All, Processing, In Transit, Delivered and Cancelled filters.
- New orders start in Processing and immediately initialize a simulated live transit route.
- Route geometry is requested from OSRM when available, with a safe straight-line fallback.
- The vehicle marker animates along the route according to the predicted ETA.
- Map points can be selected directly for origin/destination.
- Active route state is kept in browser localStorage so a refresh can resume a simulation.
- Delivery status is persisted through the order status API.


## FleetFlow AI 2.1 — Smart Locations + Real-Time Clock

### New dashboard capabilities
- Creative command navigation: Overview, Plan, Live Map, Orders, Fleet, More and AI Copilot.
- Dedicated status bar: All, Processing, In Transit, Delivered and Cancelled.
- Origin and Destination are intelligent location-search fields backed by OpenStreetMap Nominatim.
- Prefix/incomplete queries such as `Ten` return matching locations such as Tenali when available.
- Selecting locations automatically obtains coordinates and calculates road distance through OSRM.
- Manual distance entry has been removed from the user flow.
- Delivery ETA is stored as an absolute UTC timestamp (`eta_at`).
- The server synchronizes In Transit orders against the real clock and marks them Delivered at ETA.
- The browser polls the server so open dashboards update automatically without a page refresh.
- The live map draws routes and positions the vehicle according to elapsed time between `transit_started_at` and `eta_at`.
- Refreshing the dashboard does not reset progress.
- FleetAI remains a floating modal and answers questions about the new location, routing, ETA and status behavior.

### Local run
```text
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
set ADMIN_EMAIL=your-admin-email
set ADMIN_PASSWORD=your-admin-password
python app.py
```

### Render
Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in Render Environment Variables. The admin account is provisioned once and the public registration route always creates normal `user` accounts.

## FleetFlow 3.0 Admin & Prism UI Upgrade
- Global Admin now has an order control center with Edit and Delete actions.
- Admin edits can change customer, origin, destination, latitude/longitude, traffic, weather, priority and status.
- Admin map pins can replace origin/destination coordinates; saving recalculates road distance and ETA.
- Editing an In Transit order restarts its stored ETA from the save time using the updated route.
- Admin deletion is server-authorized and removes the order from the database.
- Developers is now a primary navigation item, not hidden inside a More menu.
- Navigation uses Command, Planner, Live Map, Orders, Fleet, Developers, Admin and AI controls with a compact tracking status rail.
- Visual theme changed from green-heavy to a prism palette: violet, cyan, amber, coral and deep navy.
- Normal users cannot access admin APIs; the single global admin remains server-provisioned through ADMIN_EMAIL and ADMIN_PASSWORD.


## Vehicle-Specific Live Map Icons
- Bike orders use a motorcycle icon.
- Van orders use a van icon.
- EV Van orders use an EV/charging van icon.
- Mini Truck orders use a truck icon.
- The icon changes automatically if an admin edits the vehicle type.
- The marker rotates toward the next route segment so the vehicle visually follows the route direction.


## V6 Animated UI
- Animated login/register experience with glassmorphism, orbit/radar background motion and gradient branding.
- Animated ambient background and grid across application pages.
- Smooth page entrance animations.
- Animated navigation transitions instead of plain jumps.
- Click ripples and hover motion on navigation/buttons.
- Focus animations on form fields.
- Responsive auth layout.


## V7 Order Details & Permissions
- Clicking an order row opens an animated detail modal.
- Normal users can only cancel their own cancellable orders.
- Admins can edit, cancel, or permanently delete any order.
- Admin route editing supports origin/destination geocoding and automatically recalculates road distance and ETA.
- Admin can change vehicle type and status from the order details panel.


## V8 Order Details + Fractured Motion
- Clicking an order row or Details button opens the order details modal.
- Normal users can cancel an eligible order only.
- Admins can edit route/vehicle/status and delete orders.
- Admin edits recalculate road distance and ETA through the backend.
- Navigation now uses a fractured/broken-glass style transition.
- Order detail modal has a distinct broken-card entrance animation.


## V12 Password Management UX
- User directory no longer exposes password-change controls directly.
- Click a user row to open account details.
- The password control appears only after the admin explicitly clicks "Change Password".
- Password form is a separate modal and is never displayed inline.
- Admin password update uses the protected backend endpoint with the same strong-password validation.
