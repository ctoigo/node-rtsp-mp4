'use strict'

const fs = require('fs');
const express = require('express');
const request = require('request');
const sockets = require('./sockets');
const bodyParser = require('body-parser');
const cors = require('cors');
const app = express();

var originsWhitelist = [
    '' // colocar endereço de IP para liberação de conexão
 ];
var corsOptions = {
   origin: function(origin, callback){
       var isWhitelisted = originsWhitelist.indexOf(origin) !== -1;
       callback(null, isWhitelisted);
   },
   credentials:true
}
app.use(cors(corsOptions)); 

app.use((req,res,next) => {
   res.header("Access-Control-Allow-Origin", "*");
   res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
   next(); 
});

app.disable('x-powered-by')

const server = require('http').Server(app)
const https = require("https");

const options = {
    cert: fs.readFileSync(''), // arquivo PEM de certificao SSL Letsencrypt
    key: fs.readFileSync('') // arquivo de chave privada PEM de certificao SSL Letsencrypt
};


const io = require('socket.io')(server, { origins: '*:*', transports: ['websocket'] });

const Mp4Frag = require('mp4frag')

const FR = require('ffmpeg-respawn')

const { path: ffmpegPath } = require('ffmpeg-static')

const streams = new Map()

app.locals.streams = streams

app.use(bodyParser.json());

app.get('/start/*', function(req, res) {

  const parametros = req.params;
  const id = parametros[0];

  request('***servidor**' + id, (error, response, body)=> { // Aqui vai uma API de servidor onde estão as lista de DVR onde ele retorna os endereços de RTSP
    if (!error && response.statusCode === 200) {
        const cam = JSON.parse(body)
        if (streams.has(cam.dados.name_rtsp)) {
            res.send(JSON.stringify({ endereco: cam.dados.name_rtsp, success: true }));
        }
        const mp4frag = new Mp4Frag({ hlsBase: cam.dados.name_rtsp, hlsListSize: 3 })

        const params = [
          "-hwaccel",
          "auto",
          "-probesize",
          "1048576",
          "-analyzeduration",
          "10000000",
          "-reorder_queue_size",
          "0",
          "-rtsp_transport",
          "tcp",
          "-i",
          cam.dados.rtsp,
          "-an",
          "-c:v",
          "copy",
          "-f",
          "mp4",
          "-movflags",
          "+dash+negative_cts_offsets",
          "-metadata",
          "title=" + cam.dados.nome,
          "pipe:1"
      ];

      const ffmpeg = new FR(
        {
          path: ffmpegPath,
          logLevel: "quiet",
          killAfterStall: 10,
          spawnAfterExit: 5,
          reSpawnLimit: Number.POSITIVE_INFINITY,
          params: params,
          pipes: [
            { stdioIndex: 1, destination: mp4frag }
          ],
          exitCallback: (code, signal) => {
            console.error('exit', cam.dados.nome, code, signal)
            if (mp4frag) {
              mp4frag.resetCache()
            }
          }
        })
        .start();

      streams.set(cam.dados.name_rtsp, { ffmpeg: ffmpeg, mp4frag: mp4frag });

      const namespace = `/${cam.dados.name_rtsp}`;

      io
        .of(namespace)// accessing "/namespace" of io based on id of stream
        .on('connection', (socket) => { // listen for connection to /namespace
          console.log(`a user connected to namespace "${namespace}"`)

          // event listener
          const onInitialized = () => {
            socket.emit('mime', mp4frag.mime)
            mp4frag.removeListener('initialized', onInitialized)
          }

          // event listener
          const onSegment = (data) => {
            socket.emit('segment', data)
            console.log('emit segment', data.length);
          }

          // client request
          const mimeReq = () => {
            if (mp4frag.mime) {
              console.log(`${namespace} : ${mp4frag.mime}`)
              socket.emit('mime', mp4frag.mime)
            } else {
              mp4frag.on('initialized', onInitialized)
            }
          }

          // client request
          const initializationReq = () => {
            socket.emit('initialization', mp4frag.initialization)
          }

          // client request
          const segmentsReq = () => {
            // send current segment first to start video asap
            if (mp4frag.segment) {
              socket.emit('segment', mp4frag.segment)
            }
            // add listener for segments being dispatched by mp4frag
            mp4frag.on('segment', onSegment)
          }

          // client request
          const segmentReq = () => {
            if (mp4frag.segment) {
              socket.emit('segment', mp4frag.segment)
            } else {
              mp4frag.once('segment', onSegment)
            }
          }

          // client request
          const pauseReq = () => { // same as stop, for now. will need other logic todo
            mp4frag.removeListener('segment', onSegment)
          }

          // client request
          const resumeReq = () => { // same as segment, for now. will need other logic todo
            mp4frag.on('segment', onSegment)
            // may indicate that we are resuming from paused
          }

          // client request
          const stopReq = () => {
            mp4frag.removeListener('segment', onSegment)
            mp4frag.removeListener('initialized', onInitialized)
            // stop might indicate that we will not request anymore data todo
          }

          // listen to client messages
          socket.on('message', (msg) => {
            console.log(`${namespace} message : ${msg}`)
            switch (msg) {
              case 'mime' :// client is requesting mime
                mimeReq()
                break
              case 'initialization' :// client is requesting initialization segment
                initializationReq()
                break
              case 'segment' :// client is requesting a SINGLE segment
                segmentReq()
                break
              case 'segments' :// client is requesting ALL segments
                segmentsReq()
                break
              case 'pause' :
                pauseReq()
                break
              case 'resume' :
                resumeReq()
                break
              case 'stop' :// client requesting to stop receiving segments
                stopReq()
                break
            }
          });

          socket.on('disconnect', () => {
            stopReq()
            console.log(`A user disconnected from namespace "${namespace}"`)
          });
      });

      res.send(JSON.stringify({ endereco: cam.dados.name_rtsp, success: true }));
    } else {
      console.log("Got an error: ", error, ", status code: ", response.statusCode)
    }
  })

});

app.all('/*', function (req, res, next) {
  next();
});

app.param('id', (req, res, next, id) => {
  const streams = app.locals.streams
  const stream = streams.get(id)
  if (!stream) {
    return res.status(404)
      .end(`stream "${id}" not found`)
  }
  if (!stream.hasOwnProperty('ffmpeg')) {
    return res.status(500)
      .end(`stream "${id}" does not have a valid ffmpeg src`)
  }
  res.locals.id = id
  res.locals.stream = stream
  next()
});

app.param('type', (req, res, next, type) => {
  const stream = res.locals.stream
  switch (type) {
    case 'mp4' :
      if (!stream.ffmpeg.running) {
        return res.status(503)
          .end(`stream "${res.locals.id}" is currently not running`)
      }
      if (stream.hasOwnProperty('mp4frag')) {
        res.locals.mp4frag = stream.mp4frag
        return next()
      }
      return res.status(404)
        .end(`mp4 type not found for stream ${res.locals.id}`)
    case 'cmd' :
      if (stream.hasOwnProperty('ffmpeg')) {
        res.locals.ffmpeg = stream.ffmpeg
        return next()
      }
      return res.status(404)
        .end(`cmd type not found for stream ${res.locals.id}`)
    case 'debug' :
      return res.end(inspect(res.locals.stream, { sorted: true, showHidden: false, compact: false, depth: 2, colors: false, breakLength: 200, getters: true}))
    default :
      res.status(404)
        .end(`${type} type not found for stream ${res.locals.id}`)
  }
})

app.get('/stream/:id/:type/*', (req, res, next) => {
  next()
})

app.get(`/stream/*/mp4/video.mp4`, (req, res) => {
  const mp4frag = res.locals.mp4frag
  const init = mp4frag.initialization
  if (!init) {
    return res.status(503)
      .set('Retry-After', 10)
      .end(`Stream "${res.locals.id}" video.mp4 currently unavailable. Please try again later.`)
  }

  res.status(200)
    .set('Access-Control-Allow-Origin', '*')
    .set('Connection', 'close')
    .set('Cache-Control', 'private, no-cache, no-store, must-revalidate')
    .set('Expires', '-1')
    .set('Pragma', 'no-cache')
    .set('Content-Type', 'video/mp4')
    .write(init)
  const segment = mp4frag.segment
  if (segment) {
    res.write(segment)
  }
  mp4frag.pipe(res, { 
    end: true 
  });
  res.once('close', () => {
    if (mp4frag) {
      mp4frag.unpipe(res);
    }
    res.end();
  });
});

sockets(io, streams)

server.listen(3000, () => {
  console.log('listening on localhost:3000')
})

https.createServer(options, app).listen(3001, function() {
  console.log("Listening on localhost:3001");
});

module.exports = app
