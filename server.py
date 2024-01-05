#!/usr/bin/env python
from collections import OrderedDict
from threading import Lock
from io import BytesIO
from optparse import OptionParser
import os, sys, math, json, re, tkinter, multiprocessing
import tkinter.filedialog
import requests
from flask import Flask, abort, make_response, render_template, url_for, request
from flaskwebgui import FlaskUI, close_application

import logging
logging.getLogger('werkzeug').setLevel(logging.ERROR)

from detect import *

if os.name == 'nt':
    _dll_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'openslide\\bin')
    if _dll_path is not None:
        if hasattr(os, 'add_dll_directory'):
            # Python >= 3.8
            with os.add_dll_directory(_dll_path):
                import openslide
        else:
            # Python < 3.8
            _orig_path = os.environ.get('PATH', '')
            os.environ['PATH'] = _orig_path + ';' + _dll_path
            import openslide

            os.environ['PATH'] = _orig_path
else:
    import openslide

from openslide import OpenSlide, OpenSlideCache, OpenSlideError, OpenSlideVersionError
from openslide.deepzoom import DeepZoomGenerator

SLIDE_DIR = '.'
SLIDE_CACHE_SIZE = 10
SLIDE_TILE_CACHE_MB = 128
DEEPZOOM_SLIDE = None
DEEPZOOM_FORMAT = 'jpeg'
DEEPZOOM_TILE_SIZE = 254
DEEPZOOM_OVERLAP = 1
DEEPZOOM_LIMIT_BOUNDS = True
DEEPZOOM_TILE_QUALITY = 100
SLIDE_NAME = 'slide'
MAGNIFICATIONS = ["5x", "10x", "20x", "40x", "80x"]

app = Flask(__name__)
app.config.from_object(__name__)
app.config.from_envvar('DEEPZOOM_MULTISERVER_SETTINGS', silent=True)
class _SlideCache:
    def __init__(self, cache_size, tile_cache_mb, dz_opts):
        self.cache_size = cache_size
        self.dz_opts = dz_opts
        self._lock = Lock()
        self._cache = OrderedDict()
        # Share a single tile cache among all slide handles, if supported
        try:
            self._tile_cache = OpenSlideCache(tile_cache_mb * 1024 * 1024)
        except OpenSlideVersionError:
            self._tile_cache = None
    def get(self, path):
        with self._lock:
            if path in self._cache:
                # Move to end of LRU
                slide = self._cache.pop(path)
                self._cache[path] = slide
                return slide
        osr = OpenSlide(path)
        if self._tile_cache is not None:
            osr.set_cache(self._tile_cache)
        slide = DeepZoomGenerator(osr, **self.dz_opts)
        try:
            mpp_x = osr.properties[openslide.PROPERTY_NAME_MPP_X]
            mpp_y = osr.properties[openslide.PROPERTY_NAME_MPP_Y]
            slide.mpp = (float(mpp_x) + float(mpp_y)) / 2
            slide.size = slide.level_dimensions
        except (KeyError, ValueError):
            slide.mpp = 0
        with self._lock:
            if path not in self._cache:
                if len(self._cache) == self.cache_size:
                    self._cache.popitem(last=False)
                self._cache[path] = slide
        return slide
class _Directory:
    def __init__(self, basedir, relpath=''):
        self.name = os.path.basename(relpath)
        self.children = []
        for name in sorted(os.listdir(os.path.join(basedir, relpath))):
            cur_relpath = os.path.join(relpath, name)
            cur_path = os.path.join(basedir, cur_relpath)
            if os.path.isdir(cur_path):
                cur_dir = _Directory(basedir, cur_relpath)
                if cur_dir.children:
                    self.children.append(cur_dir)
            elif OpenSlide.detect_format(cur_path):
                self.children.append(_SlideFile(cur_relpath))
class _SlideFile:
    def __init__(self, relpath):
        self.name = os.path.basename(relpath)
        self.url_path = relpath

config_map = {
    'DEEPZOOM_TILE_SIZE': 'tile_size',
    'DEEPZOOM_OVERLAP': 'overlap',
    'DEEPZOOM_LIMIT_BOUNDS': 'limit_bounds',
}
opts = {v: app.config[k] for k, v in config_map.items()}
app.cache = _SlideCache(app.config['SLIDE_CACHE_SIZE'], app.config['SLIDE_TILE_CACHE_MB'], opts)

def _get_slide(path):
    if not os.path.exists(path):
        abort(404)
    try:
        slide = app.cache.get(path)
        slide.filename = os.path.basename(path)
        return slide
    except OpenSlideError:
        abort(404)

@app.route('/loadslide_<path:path>')
def slide(path):
    print('opening:', path)
    slide = _get_slide(path)
    slide_url = url_for('dzi', path=path)
    return make_response({
        "url": slide_url,
        "mpp": slide.mpp,
        "dimensions": list(slide.size),
        "magnifications": MAGNIFICATIONS[:len(slide.size)]
    })

@app.route('/<path:path>.dzi')
def dzi(path):
    slide = _get_slide(path)
    format = app.config['DEEPZOOM_FORMAT']
    resp = make_response(slide.get_dzi(format))
    resp.mimetype = 'application/xml'
    return resp

@app.route('/<path:path>_files/<int:level>/<int:col>_<int:row>.<format>')
def tile(path, level, col, row, format):
    slide = _get_slide(path)
    format = format.lower()
    if format != 'jpeg' and format != 'png': # Not supported by Deep Zoom
        abort(404)
    try:
        tile = slide.get_tile(level, (col, row))
    except ValueError: # Invalid level or coordinates
        abort(404)
    buf = BytesIO()
    tile.save(buf, format, quality=app.config['DEEPZOOM_TILE_QUALITY'])
    resp = make_response(buf.getvalue())
    resp.mimetype = 'image/%s' % format
    return resp

def predict(slide, level, col, row):
    try:
        tile = slide.get_tile(level, (col, row))
        return {"x":col, "y":row, "p":score(tile), "d": 0}
    except ValueError: # Invalid level or coordinates
        abort(404)

@app.route('/predict_<path:path>/<int:level>/<int:col>_<int:row>')
def predicttile(path, level, col, row):
    slide = _get_slide(path)
    res = predict(slide, level, col, row)
    return make_response([res])

predictprogress = {}
def predictall(path):
    global predictprogress
    slide = _get_slide(path)
    size = slide.size[-1]
    level = math.ceil(math.log2(max(size)))
    ntiles = {"x": int(size[0]/DEEPZOOM_TILE_SIZE), "y":int(size[1]/DEEPZOOM_TILE_SIZE)}
    print('size:',ntiles)
    data = {
        "size": ntiles,
        "probs": []
    }
    predictprogress[path] = 0
    for x in range(1, ntiles['x']):
        if app.interrupt:
            break
        for y in range(1, ntiles['y']):
            if app.interrupt:
                break
            p = predict(slide, level, x, y)
            if (p['p'] > 10000):
                data['probs'].append(p)
        predictprogress[path] = x/ntiles['x']*100
    if not app.interrupt:
        with open(path+".json", "w") as outfile:
            data['probs'] = sorted(data['probs'], reverse=True, key=lambda k: k['p'])
            json.dump(data, outfile, separators=(',', ':'))
        predictprogress[path] = 100

@app.route('/predictfiles', methods=['POST'])
def predictfiles():
    global predictprogress
    app.interrupt = False
    data = request.get_json()
    print('analyzing files:', data)
    for path in data['files']:
        if not app.interrupt:
            print('starting', path)
            predictall(path)
    if app.interrupt:
        print('interrupted')
        predictprogress['interrupted'] = -1
    else:
        print('all done')
        predictprogress['done'] = -1
    return make_response()

@app.route('/predictinterrupt')
def predictinterrupt():
    app.interrupt = True
    return make_response()

@app.route('/predictprogress')
def getprogress():
    global predictprogress
    print(predictprogress)
    predictprogress = {k:v for k,v in predictprogress.items() if v > -1 and v < 100}
    return make_response(temp)

@app.route('/upload_<path:path>/<int:level>/<int:col>_<int:row>_<int:decision>')
def upload(path, level, col, row, decision):
    print("uploading:", path)
    slide = _get_slide(path)
    try:
        tile = slide.get_tile(level, (col, row))
        buf = BytesIO()
        tile.save(buf, 'jpeg', quality=app.config['DEEPZOOM_TILE_QUALITY'])
        img = {'image': buf.getvalue()}
        r = requests.post('http://dev.dataxlab.org/img',
            files = img,
            data = {'name': re.search('\d+(?=\.svs)', path).group(0), 'x': col, 'y': row, 'd': decision}
        )
        if r.status_code == 200:
            return make_response({"success":1})
    except Exception as e: # Invalid level or coordinates
        print(e)
    abort(404)

@app.route("/")
def viewer():
    return render_template('viewer.html')

@app.route("/askopenfiles")
def openfiles():
    tk = tkinter.Tk()
    tk.withdraw()
    tk.wm_attributes('-topmost', 1)
    files = tkinter.filedialog.askopenfiles(mode='r', filetypes=[("Slide Files", "*.svs")])
    tk.destroy()
    files = [file.name for file in files]
    out = []
    for file in files:
        data = {}
        if os.path.isfile(file+'.json'):
            data = json.load(open(file+'.json'))
        out.append({"name":file, "data":data})
    return make_response(out)

@app.route("/openfiles", methods=['POST'])
def openfilespost():
    data = request.get_json()
    print(data)
    out = []
    for file in data['files']:
        print(file)
        data = {}
        if os.path.isfile(file+'.json'):
            data = json.load(open(file+'.json'))
        out.append({"name":file, "data":data})
    return make_response(out)

@app.route("/save_<path:path>", methods=['POST'])
def save(path):
    data = request.get_json()
    print('writing:', path)
    with open(path, 'w') as file:
        json.dump(data, file)
    return make_response({"success":1})

@app.route("/close")
def close_window():
    close_application()

def main():
    parser = OptionParser(usage='Usage: %prog [options] [slide]')
    parser.add_option('-B','--ignore-bounds',dest='DEEPZOOM_LIMIT_BOUNDS',default=True,action='store_false',help='display entire scan area')
    parser.add_option('-c','--config',metavar='FILE',dest='config',help='config file')
    parser.add_option('-d','--debug',dest='DEBUG',action='store_true',help='run in debugging mode (insecure)')
    parser.add_option('-e','--overlap',metavar='PIXELS',dest='DEEPZOOM_OVERLAP',type='int',help='overlap of adjacent tiles [1]')
    parser.add_option('-f','--format',metavar='{jpeg|png}',dest='DEEPZOOM_FORMAT',help='image format for tiles [jpeg]')
    parser.add_option('-l','--listen',metavar='ADDRESS',dest='host',default='127.0.0.1',help='address to listen on [127.0.0.1]')
    parser.add_option('-p','--port',metavar='PORT',dest='port',type='int',default=5000,help='port to listen on [5000]')
    parser.add_option('-Q','--quality',metavar='QUALITY',dest='DEEPZOOM_TILE_QUALITY',type='int',help='JPEG compression quality [75]')
    parser.add_option('-s','--size',metavar='PIXELS',dest='DEEPZOOM_TILE_SIZE',type='int',help='tile size [254]')
    (opts, args) = parser.parse_args()
    # Load config file if specified
    if opts.config is not None:
        app.config.from_pyfile(opts.config)
    # Overwrite only those settings specified on the command line
    for k in dir(opts):
        if not k.startswith('_') and getattr(opts, k) is None:
            delattr(opts, k)
    app.config.from_object(opts)
    FlaskUI(app=app, server="flask", port=5000).run()
    print('ready')
if __name__ == '__main__':
    main()