/**
 *
 * HTML Injector
 *  - a BrowserSync.io plugin.
 *
 */

var _            = require("lodash");
var jsdom        = require("jsdom").jsdom;
var request      = require('request');
var tfunk        = require('tfunk');
var merge        = require('opt-merger').merge;
var compare      = require('dom-compare-temp').compare;

var PLUGIN_NAME  = "HTML Injector";
var PLUGIN_EVENT = "plugin:html:inject";
var CLIENT_EVENT = "html:inject";
var instance;

/**
 * @module bs-html-injector.options
 * Default configuration. Everything here can be overridden
 */
var defaults = {
    /**
     *
     * Define which tags are ignored by default.
     *
     * @property excludedTags
     * @type Array
     * @default ["HTML", "HEAD"]
     */
    excludedTags: ["HTML", "HEAD"]
};

/**
 * Main export, can be called when BrowserSync is running.
 * @returns {*}
 */
module.exports = function () {
    if (instance) {
        return instance.events.emit(PLUGIN_EVENT);
    }
};

/**
 * Plugin name.
 * @type {string}
 */
module.exports["plugin:name"] = PLUGIN_NAME;

/**
 * Client JS hook
 * @returns {String}
 */
module.exports["client:js"] = function () {
    return require("fs").readFileSync(__dirname + "/client.js", "utf-8");
};

/**
 * @param {BrowserSync} bs
 * @param {Object} opts
 * @param {Function} log
 */
module.exports["plugin"] = function (bs, opts, log) {

    instance = bs;

    opts = merge(defaults, opts, {});

    var url;
    var canFetchNew = true;
    var sockets     = bs.io.sockets;
    var inject      = getInjector(sockets, log);
    var oldDom;

    sockets.on("connection", function (client) {

        client.on("client:url", function (data) {

            if (!canFetchNew) {
                return;
            }

            url = data.url;

            request(url, function (error, response, body) {
                canFetchNew = false;
                setTimeout(function () {
                    canFetchNew = true;
                }, 2000);
                log("debug", "Stashing: " + url);
                if (!error && response.statusCode == 200) {
                    oldDom = createDom(body);
                }
            });
        });
    });

    bs.events.on("file:changed", function (data) {
        if (!url || !oldDom || data.namespace !== PLUGIN_NAME) {
            return;
        }
        doNewRequest();
    });

    bs.events.on(PLUGIN_EVENT, function () {
        if (!url || !oldDom) {
            return;
        }
        doNewRequest();
    });

    function doNewRequest() {
        log("debug", "Getting new HTML from: " + url);
        requestNew(url, oldDom, function (window, diffs, newDom) {
            log("debug", "Differences found, injecting...");
            inject(window, diffs);
            oldDom = newDom;
        }, opts);
    }
};

/**
 * @param diffs
 * @param excludeList
 * @returns {*}
 */
function removeExcluded(diffs, excludeList) {
    return diffs.filter(function (item) {
        return !_.contains(excludeList, item.tagName);
    });
}

module.exports.removeExcluded = removeExcluded;

/**
 * Request new version of Dom
 * @param {String} url
 * @param {Object} oldDom
 * @param {Object} opts - plugin options
 * @param {Function} cb
 */
function requestNew (url, oldDom, cb, opts) {

    request(url, function (error, response, body) {

        if (!error && response.statusCode == 200) {

            var newDom = createDom(body);
            var diffs  = compareDoms(oldDom, newDom);
            diffs      = removeDupes(diffs);
//            diffs      = removeChildren(diffs); // unreliable right now
            diffs      = removeExcluded(diffs, opts.excludedTags || defaults.excludedTags);

            if (diffs) {
                cb(newDom.parentWindow, diffs, newDom);
            }

            oldDom = newDom;
        }
    });
}

/**
 * @param {Array} differences
 * @returns {Array}
 */
function removeDupes(differences) {

    return _.uniq(differences, "node");
}

module.exports.removeDupes = removeDupes;

/**
 * Not currently used... needs work.
 * @param {Array} differences
 * @returns {Array}
 */
function removeChildren(differences) {

    differences.reverse();

    var parents = [];

    differences.forEach(function (item, index) {

        var path = item.node;

        if (index === 0) {
            return parents.push(item);
        }

        parents.forEach(function (parentItem) {
            if (!_.contains(path, parentItem.node)) {
                return parents.push(item);
            }
        });
    });

    return parents;
}

module.exports.stripDupes = removeDupes;


/**
 * Compare two DOMS & return diffs
 * @param {Object} newDom
 * @param {Object} oldDom
 * @returns {Object}
 */
function compareDoms(oldDom, newDom) {

    var window      = newDom.parentWindow;

    var result = compare(oldDom, newDom, {
        formatFailure: function (failure, node) {
            var allElems    = node.ownerDocument.getElementsByTagName(node.nodeName);
            failure.index   = Array.prototype.indexOf.call(allElems, node);
            failure.tagName = node.nodeName;
            return failure;
        }
    });

    var same = result.getResult(); // false cause' trees are different

    if (!same) {
        return result.getDifferences(); // array of diff-objects
    }
}

module.exports.compareDoms = compareDoms;

/**
 * @param string
 * @returns {*}
 */
function createDom(string) {
    return jsdom(string);
}

/**
 * @param {Socket.io} sockets
 * @returns {Function}
 */
function getInjector(sockets, log) {

    return function (window, diffs) {

        diffs.forEach(function (item) {

            log("debug", tfunk("%Ccyan:Tag: ") + item.tagName);
            log("debug", tfunk("%Ccyan:Index: ") + item.index);
            var element = window.document.getElementsByTagName(item.tagName)[item.index];

            var elemAttrs = {};

            for (var attr, i=0, attrs=element.attributes, l=attrs.length; i<l; i++){
                attr = attrs.item(i);
                elemAttrs[attr.nodeName] = attr.nodeValue
            }

            if (element) {
                sockets.emit(CLIENT_EVENT, {
                    html: element.innerHTML,
                    tagName: item.tagName,
                    index: item.index,
                    cssText: element.style.cssText,
                    attrs: elemAttrs
                });
            }
        });
    }
}