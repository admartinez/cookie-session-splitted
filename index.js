/*!
 * cookie-session-splitted
 * from cookie-session modified by Adrian Martinez
 * Copyright(c) 2022 Adrian Martinez
 * Copyright(c) 2013 Jonathan Ong
 * Copyright(c) 2014-2017 Douglas Christopher Wilson
 * MIT Licensed
 */

'use strict'

/**
 * Module dependencies.
 * @private
 */

var Buffer = require('safe-buffer').Buffer
var debug = require('debug')('cookie-session-splitted')
var Cookies = require('cookies')
var onHeaders = require('on-headers')
var CookieModule = require('cookie')

/**
 * Module exports.
 * @public
 */

module.exports = cookieSession

/**
 * Create a new cookie session middleware.
 *
 * @param {object} [options]
 * @param {boolean} [options.httpOnly=true]
 * @param {array} [options.keys]
 * @param {string} [options.name=session] Name of the cookie to use
 * @param {boolean} [options.overwrite=true]
 * @param {string} [options.secret]
 * @param {boolean} [options.signed=true]
 * @return {function} middleware
 * @public
 */

const MAX_COOKIE_SIZE = 4096

function setChunkName (name, i) {
  return `${name}.${i}`
}

function cookieSession (options) {
  var opts = options || {}

  // cookie name
  var name = opts.name || 'session'

  // secrets
  var keys = opts.keys
  if (!keys && opts.secret) keys = [opts.secret]

  // defaults
  if (opts.overwrite == null) opts.overwrite = true
  if (opts.httpOnly == null) opts.httpOnly = true
  if (opts.signed == null) opts.signed = true

  if (!keys && opts.signed) throw new Error('.keys required.')

  if (opts.max_cookie_size == null) opts.max_cookie_size = MAX_COOKIE_SIZE

  debug('session options %j', opts)

  const { transient: emptyTransient, ...emptyCookieOptions } = options
  emptyCookieOptions.expires = emptyTransient ? 0 : new Date()
  emptyCookieOptions.path = emptyCookieOptions.path || '/'
  const emptyCookie = CookieModule.serialize(
    setChunkName(name, 0),
    '',
    emptyCookieOptions
  )
  const cookieChunkSize = opts.max_cookie_size - emptyCookie.length

  return function _cookieSession (req, res, next) {
    var cookies = new Cookies(req, res, {
      keys: keys
    })
    var sess

    // for overriding
    req.sessionOptions = Object.assign({}, opts)
    req.sessionOptions.originalName = req.sessionOptions.name
    delete req.sessionOptions.name

    // define req.session getter / setter
    Object.defineProperty(req, 'session', {
      configurable: true,
      enumerable: true,
      get: getSession,
      set: setSession
    })

    function getSession () {
      // already retrieved
      if (sess) {
        return sess
      }

      // unset
      if (sess === false) {
        return null
      }

      // get session
      if ((sess = tryGetSession(cookies, name, req.sessionOptions))) {
        return sess
      }

      // create session
      debug('new session')
      return (sess = Session.create())
    }

    function setSession (val) {
      if (val == null) {
        // unset session
        sess = false
        return val
      }

      if (typeof val === 'object') {
        // create a new session
        sess = Session.create(val)
        return sess
      }

      throw new Error('req.session can only be set as null or an object.')
    }

    function clearCookie (name, res) {
      const { domain, path, sameSite, secure } = options
      debug('clearCookie %s= %o', name, options)
      res.clearCookie(name, {
        domain,
        path,
        sameSite,
        secure
      })
    }

    onHeaders(res, function setHeaders () {
      if (sess === undefined) {
        // not accessed
        return
      }

      function setCookieInChunks (sessionName, value, sessionOptions) {
        debug('setCookieInChunks name=%s value.lengh=%s sessionOpts=%o chunksize=%d', sessionName, value.length, sessionOptions, cookieChunkSize)
        const chunkCount = Math.ceil(value.length / cookieChunkSize)

        if (chunkCount > 1) {
          debug('cookie size greater than %d, chunking', cookieChunkSize)
          for (let i = 0; i < chunkCount; i++) {
            const chunkValue = value.slice(
              i * cookieChunkSize,
              (i + 1) * cookieChunkSize
            )

            const chunkCookieName = setChunkName(sessionName, i)
            debug('setCookieInChunks setting cookie %s = %s', chunkCookieName, chunkValue)

            cookies.set(chunkCookieName, chunkValue, sessionOptions)
            debug('res.headers["Set-Cookie"] %o', res.getHeader('Set-Cookie'))
          }

          if (sessionName in cookies) {
            debug('replacing non chunked cookie with chunked cookies')
            clearCookie(sessionName, res)
          }
        } else {
          cookies.set(sessionName, value, sessionOptions)
          debug('single chunk options %j', sessionOptions)

          // Get the chunks
          var i = 0
          var chunk = null
          while (chunk) {
            var cookieName = setChunkName(name, i)
            chunk = cookies.get(cookieName)
            i++
            if (chunk) {
              res.clearCookie(cookieName)
            }
          }
        }
      }

      try {
        if (sess === false) {
          // remove
          debug('remove %s', name)
          cookies.set(name, '', req.sessionOptions)
        } else if ((!sess.isNew || sess.isPopulated) && sess.isChanged) {
          // save populated or non-new changed session
          debug('save %s', name)

          setCookieInChunks(name, Session.serialize(sess), req.sessionOptions)
        }
      } catch (e) {
        debug('error saving session %s', e.message)
      }
    })

    next()
  }
};

/**
 * Session model.
 *
 * @param {Context} ctx
 * @param {Object} obj
 * @private
 */

function Session (ctx, obj) {
  Object.defineProperty(this, '_ctx', {
    value: ctx
  })

  if (obj) {
    for (var key in obj) {
      this[key] = obj[key]
    }
  }
}

/**
 * Create new session.
 * @private
 */

Session.create = function create (obj) {
  var ctx = new SessionContext()
  return new Session(ctx, obj)
}

/**
 * Create session from serialized form.
 * @private
 */

Session.deserialize = function deserialize (str) {
  var ctx = new SessionContext()
  var obj = decode(str)

  ctx._new = false
  ctx._val = str

  return new Session(ctx, obj)
}

/**
 * Serialize a session to a string.
 * @private
 */

Session.serialize = function serialize (sess) {
  return encode(sess)
}

/**
 * Return if the session is changed for this request.
 *
 * @return {Boolean}
 * @public
 */

Object.defineProperty(Session.prototype, 'isChanged', {
  get: function getIsChanged () {
    return this._ctx._new || this._ctx._val !== Session.serialize(this)
  }
})

/**
 * Return if the session is new for this request.
 *
 * @return {Boolean}
 * @public
 */

Object.defineProperty(Session.prototype, 'isNew', {
  get: function getIsNew () {
    return this._ctx._new
  }
})

/**
 * populated flag, which is just a boolean alias of .length.
 *
 * @return {Boolean}
 * @public
 */

Object.defineProperty(Session.prototype, 'isPopulated', {
  get: function getIsPopulated () {
    return Object.keys(this).length > 0
  }
})

/**
 * Session context to store metadata.
 *
 * @private
 */

function SessionContext () {
  this._new = true
  this._val = undefined
}

/**
 * Decode the base64 cookie value to an object.
 *
 * @param {String} string
 * @return {Object}
 * @private
 */

function decode (string) {
  var body = Buffer.from(string, 'base64').toString('utf8')
  return JSON.parse(body)
}

/**
 * Encode an object into a base64-encoded JSON string.
 *
 * @param {Object} body
 * @return {String}
 * @private
 */

function encode (body) {
  var str = JSON.stringify(body)
  return Buffer.from(str).toString('base64')
}

function getCookieValueFromChunks (cookies, name, opts) {
  var returnValue = ''

  returnValue = cookies.get(name, opts)
  debug('getCookieValueFromChunks initial value %s', returnValue)
  if (!returnValue) {
    // Get the chunks
    returnValue = ''
    var i = 0
    var notfound = false
    while (!notfound) {
      var chunk = cookies.get(setChunkName(name, i))
      debug('getCookieValueFromChunks chunk position %d and value = %s', i, chunk)
      notfound = !chunk
      if (!notfound) {
        debug('Getting chunks # %d', i)
        returnValue = returnValue + chunk
      }
      i++
    }
  }
  return returnValue
}

/**
 * Try getting a session from a cookie.
 * @private
 */

function tryGetSession (cookies, name, opts) {
  var str = getCookieValueFromChunks(cookies, name, opts)

  if (!str) {
    return undefined
  }

  debug('parse %s', str)

  try {
    return Session.deserialize(str)
  } catch (err) {
    return undefined
  }
}
