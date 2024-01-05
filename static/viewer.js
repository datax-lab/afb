var ready = false;
var url = "";
var data;
var size;
var tile;
var pixel;
var level;
var osd;

var selectedfile = null;
var slidedata = false;
var thumbindex = 0;
var overlays = [];
var list = [];

const main = document.getElementById('main');
const viewer = document.getElementById('view');
const openfiles = document.getElementById('openfiles');
const loader = document.getElementById('loader');
const magtext = document.getElementById("magnification-text");
const thumbnail = document.getElementById("thumbnail");
const select = document.getElementById('select');
const button = document.getElementById('button');
const buttonyes = document.getElementById("sendyes");
const buttonno = document.getElementById("sendno");
const toptext = document.getElementById('toptext');
const topbar = document.getElementById('topbar');
const open = document.getElementById('open');
const problist = document.getElementById("problist");
const filelist = document.getElementById("filelist");
const nofiles = document.getElementById("nofiles");

var selectoverlay = document.createElement('div');
selectoverlay.id = 'selectoverlay';
selectoverlay.style.border = '3px solid black';

function isempty(obj) {
    return Object.keys(obj).length === 0;
}
async function fetchpost(url, data) {
    return await fetch(url, {
        method: "POST",
        headers: {'Accept': 'application/json', 'Content-Type': 'application/json'},
        body: JSON.stringify(data)
    });
}

function onready() {
    ready = true;
    console.log("ready");
    loader.hidden = true;
    openfiles.hidden = false;
    if (filelist.rows.length > 0) {
        button.disabled = false;
        button.innerHTML = 'Start';
        button.className = 'green';
    }
    else {
        button.innerHTML = 'No Files Selected';
    }
}
onready();

async function loadfiles() {
    let newfiles = [];
    try {
        data = await fetch('/askopenfiles');
        newfiles = await data.json();
    }
    catch {return;}
    if (data.length < 1) return;
    nofiles.hidden = true;
    if (ready) {
        button.disabled = false;
        button.innerHTML = 'Start';
    }
    newfiles.forEach(e => {loadrow(e);});
}

function loadrow(rowdata) {
    let path = rowdata.name;
    let name = path.replace(/^.*[\\/]/, '');
    let row;
    if (!name.endsWith(".svs")) return;
    row = [...filelist.rows].find(e => e.path == path);
    if (!row) {
        row = filelist.insertRow();
        row.c1 = row.insertCell();
        row.c2 = row.insertCell();
        row.c3 = row.insertCell();
        row.bar = document.createElement("div");
        row.bar.style.backgroundColor = '#555';
        row.bar.style.transitionDuration = '500ms';
        row.c2.appendChild(row.bar);
        row.updateprogress = function(p) {
            this.progress = p;
            if (p >= 100) this.load();
            else if (p <= 0) {
                this.bar.innerHTML = '';
                this.bar.style.height = '1.5vw';
                this.bar.style.width = '0';
                this.c3.innerHTML = "Awaiting Analysis";
            }
            else {
                this.bar.innerHTML = ''+Math.round(p)+'%';
                this.bar.style.width = ''+p*0.23+'vw';
            }
        }
        row.updatedecision = function(p) {
            this.ndecisions = p;
            if (this.nprobs == 0) this.c3.innerHTML = 'No patches detected';
            else this.c3.innerHTML = ''+p+'/'+this.nprobs;
        }
        row.adddecision = function () {this.updatedecision(this.ndecisions+1);}
        row.removedecision = function () {this.updatedecision(this.ndecisions-1);}
        row.onclick = function () {
            if (selectedfile) selectedfile.style.border = "none";
            selectedfile = this;
            this.style.border = "1px solid white";
            if (ready) loadslide(this);
        };
        row.onauxclick = function (e) {
            if (e.button == 1) filelist.deleteRow(this.rowIndex);
        }
        row.load = async function() {
            console.log(this.path);
            let data = await fetchpost('/openfiles', {files:[this.path]});
            data = await data.json()
            console.log(data[0]);
            loadrow(data[0]);
        }
        row.reload = function() {
            if ('probs' in this.data) {
                this.nprobs = this.data.probs.length;
                this.bar.style.width = '23vw';
                this.bar.innerHTML = 'Complete';
                this.progress = 100;
                let ndecisions = 0;
                this.data.probs.forEach(e => {
                    if (e['d']) ndecisions++;
                })
                this.updatedecision(ndecisions);
            }
            else row.updateprogress(0);
        }
    }
    row.name = name;
    row.c1.innerHTML = name;
    row.path = path;
    row.data = rowdata.data
    row.progress = 0;
    row.reload();
}

osd = new OpenSeadragon({
    id: "view",
    showNavigationControl: false,
    animationTime: 0.5,
    blendTime: 0.1,
    constrainDuringPan: true,
    maxZoomPixelRatio: 2,
    minZoomLevel: 1,
    visibilityRatio: 1,
    zoomPerScroll: 1.2,
    zoomPerClick: 1,
    timeout: 120000,
    debugMode: false,
});
osd.addHandler("update-level", function (eventData) {
    try {
        let mag = data['magnifications'][Math.floor(eventData['level'] / 4 - 1)];
        if (mag) magtext.innerHTML = "Magnification: " + mag;
    }
    catch {}
});
osd.addHandler("canvas-click", function (eventData) {
    if (eventData.quick) { //quick click without drag
        loader.hidden = false;
        osd.viewport.panTo(eventData.position, false);
        let pos = osd.viewport.viewerElementToImageCoordinates(eventData.position);
        pos.x = Math.floor(pos.x/254);
        pos.y = Math.floor(pos.y/254);
        viewer.setimg(pos.x, pos.y);
    }
});
viewer.makesquare = function (x, y, color) {
    let name = ''+x+'_'+y;
    let overlay = document.createElement('div');
    overlays.push(overlay);
    overlay.id = name;
    overlay.style.border = '2px solid black';
    overlay.style.borderColor = 'rgb('+255*color+','+255*(1-color)+',0)';
    osd.addOverlay(overlay, new OpenSeadragon.Rect(x*tile, y*tile, tile-4*pixel, tile-4*pixel));
}
viewer.setimg = async function(x, y) {
    osd.viewport.panTo(new OpenSeadragon.Point((x+0.5)*tile, (y+0.5)*tile), false);
    osd.removeOverlay('selectoverlay');
    osd.addOverlay(selectoverlay, new OpenSeadragon.Rect(x*tile, y*tile, tile-4*pixel, tile-4*pixel));
    let response = await fetch('/'+selectedfile.path+'_files/'+level+'/'+x+'_'+y+'.jpeg', {method:'GET'});
    if (response.status != 200) {
        console.error('error getting thumbnail');
        return;
    }
    const imageBlob = await response.blob();
    const imageObjectURL = URL.createObjectURL(imageBlob);
    thumbnail.src = imageObjectURL;
    let r = await fetch('/predict_'+selectedfile.path+'/'+level+'/'+x+'_'+y);
    let score = await r.json();
    s = score[0].p/65536;
    console.log(s);
    topbar.style.width = '' + s*18 + 'vw';
    topbar.style.backgroundColor = 'rgb('+255*s+','+255*(1-s)+',0)';
}
thumbnail.onload = function() {
    if (ready && !loader.hidden) loader.hidden = true;
}

async function loadslide(row) {
    let r = await fetch('/loadslide_'+row.path);
    data = await r.json();
    console.log(data);
    osd.open(data['url'], 0);
    open.hidden = true;
    viewer.hidden = false;
    loader.hidden = false;
    let a = data['dimensions'][data['dimensions'].length-1];
    size = {x:a[0], y:a[1]};
    level = Math.ceil(Math.log2(Math.max(size.x, size.y)));
    tile = 254.0/size.x;
    pixel = 1.0/size.x;

    loader.hidden = true;
    button.hidden = true;
    buttonyes.hidden = false;
    buttonno.hidden = false;
    buttonyes.disabled = true;
    buttonno.disabled = true;
    slidedata = row.data
    if ('probs' in slidedata && slidedata.probs.length > 0) {
        buttonyes.disabled = false;
        buttonno.disabled = false;
        last = null;
        slidedata.probs.slice(0, 1000).forEach(async (e,i) => {
            let s = Math.pow(e.p/65280, 0.5);
            viewer.makesquare(e.x, e.y, s);
            let row = problist.insertRow();
            let c1 = row.insertCell();
            let c2 = row.insertCell();
            let c3 = row.insertCell();
            c1.innerHTML = '' + (i+1);
            let bar = document.createElement("div");
            bar.style.backgroundColor = 'rgb('+255*s+','+255*(1-s)+',0)';
            bar.style.width = '' + s*6 + 'vw';
            bar.style.height = '1.5vh';
            bar.style.borderRadius = '3px';
            c2.appendChild(bar);
            if ('d' in e) c3.innerHTML = decisiontext[e.d];
            else if (last == null) last = i;
            row.onclick = function(){viewprob(i);};
            list.push(row);
        });
        if (last != null) viewprob(last);
        else viewprob(0);
    }
    else {
        slidedata = false;
        toptext.childNodes[0].nodeValue = 'No patches detected';
    }
}
function viewprob(i) {
    if (!slidedata || i < 0 || i >= slidedata.probs.length) return;
    list[thumbindex].style.border = 'none';
    list[i].style.border = '1px solid white';
    list[i].scrollIntoView({behavior:"smooth", block:"nearest", inline:"nearest"});
    thumbindex = i;
    let d = slidedata.probs[i];
    toptext.childNodes[0].nodeValue = '' + (i+1) + '/' + slidedata.probs.length;
    viewer.setimg(d.x, d.y);
    osd.viewport.zoomTo(50);
}

async function back() {
    await fetchpost('/save_' + selectedfile.path + '.json', slidedata);
    open.hidden = false;
    viewer.hidden = true;
    osd.clearOverlays();
    slidedata = false;
    overlays = [];
    list = [];
    problist.innerHTML = '';
    toptext.childNodes[0].nodeValue = 'Select A Slide';
    topbar.style.width = '0';
    thumbnail.src = '/static/images/empty.png';
    button.hidden = false;
    buttonyes.hidden = true;
    buttonno.hidden = true;
}

var interrupt = false;
var fetchprogress = 0;
async function predict() {
    button.className = 'yellow';
    button.innerHTML = 'Working...';
    let paths = [...filelist.rows].filter(e => e.progress < 100).map(e => {return e.path});
    fetchpost('/predictfiles', {files:paths});
    button.onclick = predictinterrupt;
    clearInterval(fetchprogress);
    fetchprogress = setInterval(getprogress, 1000);
}
async function predictinterrupt() {
    button.className = 'green';
    button.innerHTML = 'Start';
    button.onclick = predict;
    clearInterval(fetchprogress);
    fetch('/predictinterrupt')
}
async function getprogress() {
    data = await fetch('/predictprogress');
    data = await data.json();
    console.log(data);
    if ('interrupted' in data) {
        clearInterval(fetchprogress);
    }
    if ('done' in data) {
        let files = [...filelist.rows].filter(e => e.progress < 100).map(e => e.path);
        let newfiles = [];
        try {
            data = await fetchpost('/openfiles', {files:files});
            newfiles = await data.json();
        }
        catch {}
        newfiles.forEach(e => {loadrow(e);});
        predictinterrupt();
    }
    if (isempty(data)) {
        predictinterrupt();
        return;
    }
    for (const [path, progress] of Object.entries(data)) {
        [...filelist.rows].find(e => e.path == path).updateprogress(progress);
    }
}

const decisiontext = ['-','✖','✓'];
async function decide(decision) {
    try {
        if (slidedata) {
            if (slidedata.probs[thumbindex].d == decision) return;
            if (slidedata.probs[thumbindex].d == 0) {
                slidedata.probs[thumbindex].d = decision;
                selectedfile.adddecision();
            }
            else {
                slidedata.probs[thumbindex].d = 0;
                selectedfile.removedecision();
            }
            await fetch('/upload_'+selectedfile.path+'/'+level+'/'+slidedata.probs[thumbindex].x+'_'+slidedata.probs[thumbindex].y+'_'+slidedata.probs[thumbindex].d);
            list[thumbindex].childNodes[2].innerHTML = decisiontext[slidedata.probs[thumbindex].d];
        }
    }
    catch (e) {console.log(e);}
}

let keys = {
    ArrowUp:    ()=>viewprob(thumbindex-1),
    ArrowDown:  ()=>viewprob(thumbindex+1),
    ArrowLeft:  ()=>decide(1),
    ArrowRight: ()=>decide(2),
    ctrl_r:     ()=>{location.reload();}
};
document.addEventListener('keydown', e=>{
    if (e.key != 'i') e.preventDefault();
    let key = e.key;
    if (e.ctrlKey) key = 'ctrl_'+key;
    if (key in keys) keys[key]();
}, true);