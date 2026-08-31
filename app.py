import os, sqlite3, math, json, re
from datetime import datetime, timedelta, timezone
from functools import wraps
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

from flask import Flask, render_template, request, redirect, url_for, session, jsonify, flash
from werkzeug.security import generate_password_hash, check_password_hash

app=Flask(__name__)
app.secret_key=os.environ.get("SECRET_KEY","change-this-in-render")
DB=os.environ.get("DATABASE_PATH","delivery_fleet.db")

# Public geocoding/routing services. They are used server-side so the browser does not
# need to call them directly. If they are temporarily unavailable, the app falls back
# to local demo coordinates and straight-line distance.
NOMINATIM_URL="https://nominatim.openstreetmap.org/search"
OSRM_URL="https://router.project-osrm.org/route/v1/driving"
USER_AGENT="FleetFlowAI/2.0 delivery-planner-demo"


def utc_now():
    return datetime.now(timezone.utc)


def iso_utc(dt=None):
    return (dt or utc_now()).astimezone(timezone.utc).isoformat()


def parse_dt(value):
    if not value:
        return None
    try:
        x=value.replace("Z","+00:00")
        dt=datetime.fromisoformat(x)
        if dt.tzinfo is None:
            dt=dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def db():
    c=sqlite3.connect(DB)
    c.row_factory=sqlite3.Row
    return c


def validate_password(password):
    """Require a strong password: 8+ chars, letter, number and symbol."""
    if not isinstance(password, str) or len(password) < 8:
        return False, "Password must be at least 8 characters long."
    if not re.search(r"[A-Za-z]", password):
        return False, "Password must contain at least one letter."
    if not re.search(r"\d", password):
        return False, "Password must contain at least one number."
    if not re.search(r"[^A-Za-z0-9]", password):
        return False, "Password must contain at least one symbol (for example !, @, # or $)."
    return True, ""


def init_db():
    c=db()
    c.execute("""CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL)""")
    c.execute("""CREATE TABLE IF NOT EXISTS orders(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, customer TEXT, origin TEXT, destination TEXT,
      distance REAL, traffic INTEGER, weather INTEGER, priority TEXT, vehicle_type TEXT,
      predicted_minutes REAL, status TEXT DEFAULT 'Processing', created_at TEXT NOT NULL,
      origin_lat REAL, origin_lon REAL, destination_lat REAL, destination_lon REAL,
      transit_started_at TEXT, delivered_at TEXT, eta_at TEXT)""")
    existing={row["name"] for row in c.execute("PRAGMA table_info(orders)").fetchall()}
    migrations={
      "origin_lat":"ALTER TABLE orders ADD COLUMN origin_lat REAL",
      "origin_lon":"ALTER TABLE orders ADD COLUMN origin_lon REAL",
      "destination_lat":"ALTER TABLE orders ADD COLUMN destination_lat REAL",
      "destination_lon":"ALTER TABLE orders ADD COLUMN destination_lon REAL",
      "transit_started_at":"ALTER TABLE orders ADD COLUMN transit_started_at TEXT",
      "delivered_at":"ALTER TABLE orders ADD COLUMN delivered_at TEXT",
      "eta_at":"ALTER TABLE orders ADD COLUMN eta_at TEXT",
    }
    for col,statement in migrations.items():
        if col not in existing:
            c.execute(statement)
    c.execute("UPDATE orders SET status='Processing' WHERE status='Planned'")
    c.execute("""CREATE TABLE IF NOT EXISTS fleet(
      id INTEGER PRIMARY KEY AUTOINCREMENT, vehicle_no TEXT UNIQUE, driver TEXT, vehicle_type TEXT,
      capacity INTEGER, available INTEGER DEFAULT 1, lat REAL, lon REAL, updated_at TEXT)""")
    c.execute("""CREATE TABLE IF NOT EXISTS chats(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, message TEXT, reply TEXT, created_at TEXT)""")
    c.execute("""CREATE TABLE IF NOT EXISTS ratings(
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER UNIQUE NOT NULL, user_id INTEGER NOT NULL,
      stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5), comment TEXT DEFAULT '', created_at TEXT NOT NULL)""")
    c.commit()

    # Exactly one global/admin account. Registration always creates role=user.
    admin_email=os.environ.get("ADMIN_EMAIL")
    admin_password=os.environ.get("ADMIN_PASSWORD")
    if admin_email and admin_password:
        existing_admin=c.execute("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").fetchone()
        if not existing_admin:
            try:
                c.execute("INSERT INTO users(name,email,password_hash,role,created_at) VALUES(?,?,?,?,?)",
                          ("Global Administrator",admin_email.strip().lower(),generate_password_hash(admin_password),"admin",iso_utc()))
                c.commit()
            except sqlite3.IntegrityError:
                # If the email already exists as a normal user, never promote it automatically.
                pass

    if c.execute("SELECT COUNT(*) n FROM fleet").fetchone()["n"]==0:
        now=iso_utc()
        seed=[("DL-01-TR-1024","Aarav","Bike",15,1,17.385,78.486),
              ("TS-09-EL-7788","Meera","EV Van",80,1,17.41,78.45),
              ("KA-05-MH-2211","Rohan","Mini Truck",350,1,17.36,78.52),
              ("TS-10-QR-9033","Anika","Van",120,1,17.44,78.39)]
        c.executemany("INSERT INTO fleet(vehicle_no,driver,vehicle_type,capacity,available,lat,lon,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                      [(a,b,d,e,f,g,h,now) for a,b,d,e,f,g,h in seed])
        c.commit()
    c.close()


def sync_delivery_statuses(user_id=None):
    """Make persisted order status follow the real clock whenever the app is touched."""
    now=utc_now()
    c=db()
    params=[]
    where="WHERE status='In Transit' AND eta_at IS NOT NULL"
    if user_id is not None:
        where += " AND user_id=?"
        params.append(user_id)
    rows=c.execute(f"SELECT id,eta_at FROM orders {where}",params).fetchall()
    changed=[]
    for row in rows:
        eta=parse_dt(row["eta_at"])
        if eta and now>=eta:
            c.execute("UPDATE orders SET status='Delivered', delivered_at=COALESCE(delivered_at, ?) WHERE id=?",
                      (iso_utc(eta),row["id"]))
            changed.append(row["id"])
    c.commit(); c.close()
    return changed


init_db()


def login_required(fn):
    @wraps(fn)
    def w(*a,**k):
        if "user_id" not in session:
            return redirect(url_for("login"))
        return fn(*a,**k)
    return w


def admin_required(fn):
    @wraps(fn)
    def w(*a,**k):
        if session.get("role")!="admin":
            return redirect(url_for("dashboard"))
        return fn(*a,**k)
    return w


def estimate(distance, traffic, weather, priority):
    base=distance/28*60
    t={0:1.0,1:1.15,2:1.35,3:1.6}.get(int(traffic),1)
    w={0:1.0,1:1.08,2:1.2}.get(int(weather),1)
    p={"Standard":1.0,"Express":.9,"Critical":.82}.get(priority,1)
    return round(max(8,base*t*w*p+10),1)


def allocate(distance, priority, vehicle_type):
    c=db()
    rows=c.execute("SELECT * FROM fleet WHERE available=1 ORDER BY capacity ASC").fetchall()
    best=None
    for r in rows:
        if vehicle_type and vehicle_type!="Any" and r["vehicle_type"]!=vehicle_type:
            continue
        if best is None or r["capacity"]<best["capacity"]:
            best=r
    c.close()
    return dict(best) if best else None


def haversine_km(lat1,lon1,lat2,lon2):
    r=6371.0088
    p1,p2=math.radians(lat1),math.radians(lat2)
    dp=math.radians(lat2-lat1); dl=math.radians(lon2-lon1)
    a=math.sin(dp/2)**2+math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return r*2*math.atan2(math.sqrt(a),math.sqrt(1-a))


def http_json(url, params=None):
    if params:
        url += ("&" if "?" in url else "?") + urlencode(params)
    req=Request(url,headers={"User-Agent":USER_AGENT,"Accept":"application/json"})
    with urlopen(req,timeout=8) as response:
        return json.loads(response.read().decode("utf-8"))


def geocode_places(query):
    q=query.strip()
    if len(q)<2:
        return []
    try:
        data=http_json(NOMINATIM_URL,{"q":q,"format":"jsonv2","limit":7,"addressdetails":1,"countrycodes":"in"})
        out=[]
        for x in data:
            name=x.get("display_name","")
            out.append({"name":name.split(",")[0].strip() or name,"display_name":name,
                        "lat":float(x["lat"]),"lon":float(x["lon"]),"type":x.get("type","place")})
        return out
    except Exception:
        # Useful fallback suggestions for the demo when public geocoding is rate-limited.
        seeds=[
          ("Tenali","Tenali, Andhra Pradesh",16.2428,80.6405),
          ("Tenali, Guntur","Tenali, Guntur, Andhra Pradesh",16.2428,80.6405),
          ("Uppal","Uppal, Hyderabad, Telangana",17.4058,78.5591),
          ("Gandhi Nagar","Gandhi Nagar, Hyderabad, Telangana",17.3920,78.4745),
          ("Gachibowli","Gachibowli, Hyderabad, Telangana",17.4401,78.3489),
          ("Hitech City","HITEC City, Hyderabad, Telangana",17.4435,78.3772),
          ("Kukatpally","Kukatpally, Hyderabad, Telangana",17.4849,78.4138),
          ("Madhapur","Madhapur, Hyderabad, Telangana",17.4483,78.3915),
          ("Secunderabad","Secunderabad, Telangana",17.4399,78.4983),
          ("Vijayawada","Vijayawada, Andhra Pradesh",16.5062,80.6480),
          ("Guntur","Guntur, Andhra Pradesh",16.3067,80.4365),
          ("Warangal","Warangal, Telangana",17.9784,79.5941),
        ]
        ql=q.lower()
        return [{"name":a,"display_name":b,"lat":c,"lon":d,"type":"place"} for a,b,c,d in seeds if ql in a.lower() or ql in b.lower()][:7]


def route_between(olat,olon,dlat,dlon):
    fallback_distance=haversine_km(olat,olon,dlat,dlon)
    try:
        url=f"{OSRM_URL}/{olon},{olat};{dlon},{dlat}"
        data=http_json(url,{"overview":"full","geometries":"geojson","steps":"false"})
        route=data.get("routes",[])[0]
        coords=route.get("geometry",{}).get("coordinates",[])
        points=[[p[1],p[0]] for p in coords]
        return {"distance_km":round(float(route.get("distance",fallback_distance*1000))/1000,2),
                "duration_minutes":round(float(route.get("duration",0))/60,1),"points":points}
    except Exception:
        return {"distance_km":round(fallback_distance*1.2,2),"duration_minutes":0,
                "points":[[olat,olon],[dlat,dlon]]}


@app.route("/")
def home():
    return render_template("landing.html")


@app.route("/login",methods=["GET","POST"])
def login():
    if request.method=="POST":
        email=request.form["email"].strip().lower(); pw=request.form["password"]
        c=db(); u=c.execute("SELECT * FROM users WHERE lower(email)=?",(email,)).fetchone(); c.close()
        if u and check_password_hash(u["password_hash"],pw):
            session.update(user_id=u["id"],name=u["name"],role=u["role"],email=u["email"])
            return redirect(url_for("dashboard"))
        flash("Invalid login details.","error")
    return render_template("login.html")


@app.route("/register",methods=["GET","POST"])
def register():
    if request.method=="POST":
        name=request.form["name"].strip(); email=request.form["email"].strip().lower(); pw=request.form["password"]
        valid, password_error=validate_password(pw)
        if not valid:
            flash(password_error,"error"); return render_template("register.html")
        c=db()
        try:
            c.execute("INSERT INTO users(name,email,password_hash,role,created_at) VALUES(?,?,?,?,?)",
                      (name,email,generate_password_hash(pw),"user",iso_utc()))
            c.commit(); flash("User account created. You can sign in.","success"); return redirect(url_for("login"))
        except sqlite3.IntegrityError:
            flash("That email is already registered.","error")
        finally:
            c.close()
    return render_template("register.html")


@app.route("/logout")
def logout():
    session.clear(); return redirect(url_for("home"))


def user_stats(user_id):
    sync_delivery_statuses(user_id)
    c=db()
    stats={
      "orders":c.execute("SELECT COUNT(*) n FROM orders WHERE user_id=?",(user_id,)).fetchone()["n"],
      "processing":c.execute("SELECT COUNT(*) n FROM orders WHERE user_id=? AND status='Processing'",(user_id,)).fetchone()["n"],
      "transit":c.execute("SELECT COUNT(*) n FROM orders WHERE user_id=? AND status='In Transit'",(user_id,)).fetchone()["n"],
      "delivered":c.execute("SELECT COUNT(*) n FROM orders WHERE user_id=? AND status='Delivered'",(user_id,)).fetchone()["n"],
      "cancelled":c.execute("SELECT COUNT(*) n FROM orders WHERE user_id=? AND status='Cancelled'",(user_id,)).fetchone()["n"],
      "avg":round((c.execute("SELECT AVG(predicted_minutes) a FROM orders WHERE user_id=?",(user_id,)).fetchone()["a"] or 0),1),
      "fleet":c.execute("SELECT COUNT(*) n FROM fleet WHERE available=1").fetchone()["n"],
      "total_fleet":c.execute("SELECT COUNT(*) n FROM fleet").fetchone()["n"]
    }
    c.close()
    return stats

@app.route("/dashboard")
@login_required
def dashboard():
    return render_template("dashboard.html",stats=user_stats(session["user_id"]),requested_status="All")

@app.route("/planner")
@login_required
def planner_page():
    return render_template("planner.html",title="Planner · FleetFlow AI",requested_status="All")

@app.route("/live-map")
@login_required
def live_map_page():
    sync_delivery_statuses(session["user_id"])
    return render_template("live_map.html",title="Live Map · FleetFlow AI",requested_status="All")

@app.route("/orders")
@login_required
def orders_page():
    sync_delivery_statuses(session["user_id"])
    status=request.args.get("status","All")
    allowed={"All","Processing","In Transit","Delivered","Cancelled"}
    if status not in allowed: status="All"
    c=db()
    if status=="All":
        orders=c.execute("SELECT * FROM orders WHERE user_id=? ORDER BY id DESC",(session["user_id"],)).fetchall()
    else:
        orders=c.execute("SELECT * FROM orders WHERE user_id=? AND status=? ORDER BY id DESC",(session["user_id"],status)).fetchall()
    ratings={}
    if orders:
        c2=db()
        ids=[o["id"] for o in orders]
        qmarks=",".join("?" for _ in ids)
        for rr in c2.execute(f"SELECT order_id,stars,comment,created_at FROM ratings WHERE order_id IN ({qmarks})",ids).fetchall():
            ratings[str(rr["order_id"])]=dict(rr)
        c2.close()
    c.close()
    return render_template("orders.html",title="Orders · FleetFlow AI",orders=orders,requested_status=status,ratings=ratings)

@app.route("/fleet")
@login_required
def fleet_page():
    c=db(); fleet=c.execute("SELECT * FROM fleet ORDER BY available DESC, id").fetchall(); c.close()
    return render_template("fleet.html",title="Fleet · FleetFlow AI",fleet=fleet,requested_status="All")

@app.route("/api/geocode")
@login_required
def geocode():
    q=request.args.get("q","")
    return jsonify(results=geocode_places(q))


@app.route("/api/reverse")
@login_required
def reverse_geocode():
    try:
        lat=float(request.args["lat"]); lon=float(request.args["lon"])
        data=http_json("https://nominatim.openstreetmap.org/reverse",{"lat":lat,"lon":lon,"format":"jsonv2","zoom":18})
        display=data.get("display_name",f"Map point {lat:.5f}, {lon:.5f}")
        return jsonify(name=display.split(",")[0].strip(),display_name=display,lat=lat,lon=lon)
    except Exception:
        lat=float(request.args.get("lat",0)); lon=float(request.args.get("lon",0))
        return jsonify(name=f"Map point {lat:.5f}, {lon:.5f}",display_name="Selected map point",lat=lat,lon=lon)


@app.route("/api/route",methods=["POST"])
@login_required
def route_api():
    d=request.get_json(force=True)
    try:
        result=route_between(float(d["origin_lat"]),float(d["origin_lon"]),float(d["destination_lat"]),float(d["destination_lon"]))
        return jsonify(ok=True,**result)
    except Exception as e:
        return jsonify(ok=False,error="Unable to calculate this route."),400


@app.route("/api/predict",methods=["POST"])
@login_required
def predict():
    d=request.get_json(force=True)
    try:
        if not all(k in d for k in ("origin_lat","origin_lon","destination_lat","destination_lon")):
            return jsonify(error="Select an origin and destination from the location suggestions."),400
        route=route_between(float(d["origin_lat"]),float(d["origin_lon"]),float(d["destination_lat"]),float(d["destination_lon"]))
        distance=float(route["distance_km"])
        minutes=estimate(distance,int(d["traffic"]),int(d["weather"]),d["priority"])
        vehicle=allocate(distance,d["priority"],d.get("vehicle_type","Any"))
        eta=utc_now()+timedelta(minutes=minutes)
        return jsonify({"predicted_minutes":minutes,"distance_km":distance,"eta":eta.isoformat(),
                        "eta_local":eta.astimezone().strftime("%I:%M %p"),"allocation":vehicle})
    except (KeyError,ValueError,TypeError):
        return jsonify(error="Please select valid origin and destination locations."),400


@app.route("/api/orders",methods=["POST"])
@login_required
def create_order():
    d=request.get_json(force=True)
    try:
        olat,olon=float(d["origin_lat"]),float(d["origin_lon"])
        dlat,dlon=float(d["destination_lat"]),float(d["destination_lon"])
        route=route_between(olat,olon,dlat,dlon)
        distance=route["distance_km"]
        minutes=estimate(distance,int(d["traffic"]),int(d["weather"]),d["priority"])
    except (KeyError,ValueError,TypeError):
        return jsonify(error="A valid origin and destination are required."),400
    now=utc_now(); eta=now+timedelta(minutes=minutes)
    c=db()
    cur=c.execute("""INSERT INTO orders(
      user_id,customer,origin,destination,distance,traffic,weather,priority,vehicle_type,
      predicted_minutes,status,created_at,origin_lat,origin_lon,destination_lat,destination_lon,
      transit_started_at,eta_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
      (session["user_id"],d["customer"],d["origin"],d["destination"],distance,int(d["traffic"]),int(d["weather"]),
       d["priority"],d.get("vehicle_type","Any"),minutes,"In Transit",iso_utc(now),olat,olon,dlat,dlon,iso_utc(now),iso_utc(eta)))
    order_id=cur.lastrowid; c.commit(); c.close()
    return jsonify(ok=True,order_id=order_id,status="In Transit",minutes=minutes,distance_km=distance,
                   created_at=iso_utc(now),eta_at=iso_utc(eta),
                   origin_lat=olat,origin_lon=olon,destination_lat=dlat,destination_lon=dlon)


@app.route("/api/orders/<int:order_id>",methods=["GET"])
@login_required
def get_order(order_id):
    # Always synchronize the persisted status with the real clock before showing details.
    sync_delivery_statuses(session["user_id"])
    c=db()
    order=c.execute("SELECT * FROM orders WHERE id=? AND user_id=?",(order_id,session["user_id"])).fetchone()
    if not order:
        c.close(); return jsonify(error="Order not found"),404
    out=dict(order)
    c.close()
    return jsonify(ok=True,order=out)


@app.route("/api/orders/<int:order_id>/status",methods=["POST"])
@login_required
def update_order_status(order_id):
    d=request.get_json(force=True); status=d.get("status","").strip()
    allowed={"Processing","In Transit","Delivered","Cancelled"}
    if status not in allowed: return jsonify(error="Invalid status"),400
    c=db(); order=c.execute("SELECT * FROM orders WHERE id=? AND user_id=?",(order_id,session["user_id"])).fetchone()
    if not order: c.close(); return jsonify(error="Order not found"),404
    if order["status"]=="Delivered" and status=="Cancelled":
        c.close(); return jsonify(error="Delivered orders cannot be cancelled."),409
    now=iso_utc()
    if status=="In Transit" and not order["transit_started_at"]:
        eta=parse_dt(order["eta_at"]) or (utc_now()+timedelta(minutes=order["predicted_minutes"] or 8))
        c.execute("UPDATE orders SET status=?,transit_started_at=?,eta_at=? WHERE id=?",(status,now,iso_utc(eta),order_id))
    elif status=="Delivered":
        c.execute("UPDATE orders SET status=?,delivered_at=? WHERE id=?",(status,now,order_id))
    else:
        c.execute("UPDATE orders SET status=? WHERE id=?",(status,order_id))
    c.commit(); c.close(); return jsonify(ok=True,status=status)



@app.route("/api/admin/users/<int:user_id>/password",methods=["PUT"])
@login_required
@admin_required
def admin_change_user_password(user_id):
    d=request.get_json(silent=True) or {}
    password=d.get("password","")
    valid, error=validate_password(password)
    if not valid:
        return jsonify(error=error),400
    c=db()
    user=c.execute("SELECT id,name,email,role FROM users WHERE id=?",(user_id,)).fetchone()
    if not user:
        c.close(); return jsonify(error="User not found."),404
    # The single global administrator remains server-provisioned; it cannot be
    # converted or managed as a normal user through this control.
    if user["role"]=="admin":
        c.close(); return jsonify(error="The global administrator password is server-managed."),403
    c.execute("UPDATE users SET password_hash=? WHERE id=?",(generate_password_hash(password),user_id))
    c.commit(); c.close()
    return jsonify(ok=True,message="User password changed successfully.")


@app.route("/api/admin/orders/<int:order_id>",methods=["PUT","DELETE"])
@login_required
@admin_required
def admin_order_manage(order_id):
    c=db()
    order=c.execute("SELECT * FROM orders WHERE id=?",(order_id,)).fetchone()
    if not order:
        c.close(); return jsonify(error="Order not found"),404
    if request.method=="DELETE":
        c.execute("DELETE FROM orders WHERE id=?",(order_id,))
        c.commit(); c.close()
        return jsonify(ok=True,deleted=order_id)
    d=request.get_json(force=True)
    required=("customer","origin","destination","origin_lat","origin_lon","destination_lat","destination_lon")
    if not all(k in d for k in required):
        c.close(); return jsonify(error="Customer, locations and coordinates are required."),400
    try:
        olat,olon=float(d["origin_lat"]),float(d["origin_lon"])
        dlat,dlon=float(d["destination_lat"]),float(d["destination_lon"])
        route=route_between(olat,olon,dlat,dlon)
        distance=route["distance_km"]
        traffic=int(d.get("traffic",order["traffic"] or 0))
        weather=int(d.get("weather",order["weather"] or 0))
        priority=d.get("priority",order["priority"])
        minutes=estimate(distance,traffic,weather,priority)
        status=d.get("status",order["status"])
        if status not in {"Processing","In Transit","Delivered","Cancelled"}:
            c.close(); return jsonify(error="Invalid status"),400
        if order["status"]=="Delivered" and status=="Cancelled":
            c.close(); return jsonify(error="Delivered orders cannot be cancelled."),409
        now=utc_now()
        if status=="In Transit":
            started=iso_utc(now)
            eta=now+timedelta(minutes=minutes)
            delivered_at=None
        elif status=="Delivered":
            started=order["transit_started_at"] or order["created_at"]
            eta=now
            delivered_at=order["delivered_at"] or iso_utc(now)
        else:
            started=order["transit_started_at"]
            eta=parse_dt(order["eta_at"]) if order["eta_at"] else None
            delivered_at=order["delivered_at"] if status=="Cancelled" else None
        c.execute("""UPDATE orders SET customer=?,origin=?,destination=?,distance=?,traffic=?,weather=?,priority=?,vehicle_type=?,
          predicted_minutes=?,status=?,origin_lat=?,origin_lon=?,destination_lat=?,destination_lon=?,
          transit_started_at=?,eta_at=?,delivered_at=? WHERE id=?""",
          (d["customer"].strip(),d["origin"].strip(),d["destination"].strip(),distance,traffic,weather,priority,
           d.get("vehicle_type",order["vehicle_type"] or "Any"),minutes,status,olat,olon,dlat,dlon,started,iso_utc(eta) if eta else None,delivered_at,order_id))
        c.commit(); c.close()
        return jsonify(ok=True,order_id=order_id,distance_km=distance,minutes=minutes,status=status,
                       eta_at=iso_utc(eta) if eta else None,origin_lat=olat,origin_lon=olon,
                       destination_lat=dlat,destination_lon=dlon)
    except (ValueError,TypeError,KeyError):
        c.close(); return jsonify(error="Invalid order or location values."),400

@app.route("/api/orders/<int:order_id>/rating",methods=["GET","POST"])
@login_required
def order_rating(order_id):
    c=db()
    order=c.execute("SELECT id,status,user_id FROM orders WHERE id=?",(order_id,)).fetchone()
    if not order:
        c.close(); return jsonify(error="Order not found"),404
    if order["user_id"]!=session["user_id"] and session.get("role")!="admin":
        c.close(); return jsonify(error="You cannot rate this order."),403
    rating=c.execute("SELECT order_id,stars,comment,created_at FROM ratings WHERE order_id=?",(order_id,)).fetchone()
    if request.method=="GET":
        c.close(); return jsonify(rating=dict(rating) if rating else None)
    if order["status"]!="Delivered":
        c.close(); return jsonify(error="Rating is available only after delivery."),409
    d=request.get_json(force=True)
    try: stars=int(d.get("stars",0))
    except (TypeError,ValueError): stars=0
    if stars<1 or stars>5:
        c.close(); return jsonify(error="Choose a rating from 1 to 5 stars."),400
    comment=str(d.get("comment","")).strip()[:500]
    if rating:
        c.execute("UPDATE ratings SET stars=?,comment=?,created_at=? WHERE order_id=?",(stars,comment,iso_utc(),order_id))
    else:
        c.execute("INSERT INTO ratings(order_id,user_id,stars,comment,created_at) VALUES(?,?,?,?,?)",(order_id,session["user_id"],stars,comment,iso_utc()))
    c.commit(); out=c.execute("SELECT order_id,stars,comment,created_at FROM ratings WHERE order_id=?",(order_id,)).fetchone(); c.close()
    return jsonify(ok=True,rating=dict(out))

@app.route("/api/orders/live")
@login_required
def live_orders():
    sync_delivery_statuses(session["user_id"])
    c=db(); rows=c.execute("SELECT * FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 30",(session["user_id"],)).fetchall(); c.close()
    now=utc_now(); out=[]
    for r in rows:
        eta=parse_dt(r["eta_at"]); start=parse_dt(r["transit_started_at"] or r["created_at"])
        if eta and start and r["status"]=="In Transit":
            total=max(1,(eta-start).total_seconds()); progress=max(0,min(1,(now-start).total_seconds()/total))
        elif r["status"]=="Delivered": progress=1
        else: progress=0
        out.append({k:r[k] for k in r.keys()} | {"progress":progress})
    return jsonify(now=iso_utc(now),orders=out)


@app.route("/api/fleet",methods=["POST"])
@login_required
def add_fleet():
    if session.get("role")!="admin": return jsonify(error="Admin access required"),403
    d=request.get_json(force=True); c=db()
    try:
        c.execute("INSERT INTO fleet(vehicle_no,driver,vehicle_type,capacity,available,lat,lon,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                  (d["vehicle_no"],d["driver"],d["vehicle_type"],int(d["capacity"]),1,float(d.get("lat",17.385)),float(d.get("lon",78.486)),iso_utc()))
        c.commit(); return jsonify(ok=True)
    except sqlite3.IntegrityError: return jsonify(error="Vehicle number already exists"),409
    finally: c.close()


@app.route("/api/chat",methods=["POST"])
@login_required
def chat():
    msg=request.get_json(force=True).get("message","").strip(); low=msg.lower()
    if any(x in low for x in ("suggest","location","place","name")):
        reply="Type at least two letters in Origin or Destination. FleetFlow searches real Indian locations and ranks matching names, then uses the selected coordinates for routing."
    elif "predict" in low or "eta" in low or "time" in low:
        reply="ETA is calculated from the automatically routed distance plus traffic, weather and priority factors. The resulting ETA is stored as an exact timestamp, so the order becomes Delivered when the real clock reaches it."
    elif "fleet" in low or "vehicle" in low:
        reply="Fleet allocation selects the smallest available compatible vehicle. Admins can maintain the fleet registry; normal users cannot create an admin account."
    elif "map" in low or "route" in low or "track" in low:
        reply="The live map draws the road route between your selected locations. The delivery marker progresses using the stored start time and ETA, and refreshes against the server clock."
    elif "login" in low:
        reply="User accounts are self-registered. The single global administrator is provisioned privately through server environment variables and cannot be duplicated through the website."
    elif "status" in low or "deliver" in low:
        reply="Order status filters include All, Processing, In Transit, Delivered and Cancelled. In Transit orders automatically become Delivered when their stored ETA timestamp is reached."
    else:
        reply="I’m FleetAI. Ask me about location suggestions, automatic distance, ETA, live tracking, fleet allocation, order status or navigation."
    c=db(); c.execute("INSERT INTO chats(user_id,message,reply,created_at) VALUES(?,?,?,?)",(session["user_id"],msg,reply,iso_utc())); c.commit(); c.close()
    return jsonify(reply=reply)


@app.route("/admin")
@login_required
@admin_required
def admin():
    sync_delivery_statuses()
    c=db(); users=c.execute("SELECT id,name,email,role,created_at FROM users ORDER BY id DESC").fetchall()
    orders=c.execute("SELECT * FROM orders ORDER BY id DESC LIMIT 50").fetchall()
    fleet=c.execute("SELECT * FROM fleet ORDER BY id").fetchall(); c.close()
    return render_template("admin.html",users=[dict(r) for r in users],orders=[dict(r) for r in orders],fleet=[dict(r) for r in fleet])


@app.route("/developers")
def developers():
    return render_template("developers.html")


@app.route("/health")
def health():
    return jsonify(status="ok",service="delivery-fleet",version="3.0")


if __name__=="__main__":
    app.run(host="0.0.0.0",port=int(os.environ.get("PORT",5000)),debug=True)
