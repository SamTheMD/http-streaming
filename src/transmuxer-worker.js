/**
 * @file transmuxer-worker.js
 */

/**
 * videojs-contrib-media-sources
 *
 * Copyright (c) 2015 Brightcove
 * All rights reserved.
 *
 * Handles communication between the browser-world and the mux.js
 * transmuxer running inside of a WebWorker by exposing a simple
 * message-based interface to a Transmuxer object.
 */

/* eslint-disable prefer-const */

import window from 'global/window';
import fullMux from 'mux.js/lib/mp4';
import partialMux from 'mux.js/lib/partial';

const ONE_SECOND_IN_TS = 90000;

const typeFromStreamString = (streamString) => {
  return streamString === 'AudioSegmentStream' ? 'audio' :
    streamString === 'VideoSegmentStream' ? 'video' : '';
};

/**
 * Re-emits transmuxer events by converting them into messages to the
 * world outside the worker.
 *
 * @param {Object} transmuxer the transmuxer to wire events on
 * @private
 */
const wireFullTransmuxerEvents = function(transmuxer) {
  transmuxer.on('data', function(segment) {
    // transfer ownership of the underlying ArrayBuffer
    // instead of doing a copy to save memory
    // ArrayBuffers are transferable but generic TypedArrays are not
    // @link https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers#Passing_data_by_transferring_ownership_(transferable_objects)
    let initArray = segment.initSegment;

    segment.initSegment = {
      data: initArray.buffer,
      byteOffset: initArray.byteOffset,
      byteLength: initArray.byteLength
    };

    let typedArray = segment.data;

    segment.data = typedArray.buffer;
    window.postMessage({
      action: 'data',
      segment,
      byteOffset: typedArray.byteOffset,
      byteLength: typedArray.byteLength
    }, [segment.data]);
  });

  if (transmuxer.captionStream) {
    transmuxer.captionStream.on('data', function(caption) {
      window.postMessage({
        action: 'caption',
        data: caption
      });
    });
  }

  transmuxer.on('done', function(data) {
    window.postMessage({ action: 'done' });
  });

  transmuxer.on('gopInfo', function(gopInfo) {
    window.postMessage({
      action: 'gopInfo',
      gopInfo
    });
  });

  transmuxer.on('trackinfo', function(trackInfo) {
    window.postMessage({ action: 'trackinfo', trackInfo });
  });

  transmuxer.on('audioTimingInfo', function(audioTimingInfo) {
    window.postMessage({
      action: 'audioTimingInfo',
      audioTimingInfo: {
        start: audioTimingInfo.start / ONE_SECOND_IN_TS,
        end: audioTimingInfo.end / ONE_SECOND_IN_TS
      }
    });
  });

  transmuxer.on('videoTimingInfo', function(videoTimingInfo) {
    window.postMessage({
      action: 'videoTimingInfo',
      videoTimingInfo: {
        start: videoTimingInfo.start / ONE_SECOND_IN_TS,
        end: videoTimingInfo.end / ONE_SECOND_IN_TS
      }
    });
  });
};

const wirePartialTransmuxerEvents = function(transmuxer) {
  transmuxer.on('data', function(event) {
    // transfer ownership of the underlying ArrayBuffer
    // instead of doing a copy to save memory
    // ArrayBuffers are transferable but generic TypedArrays are not
    // @link https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers#Passing_data_by_transferring_ownership_(transferable_objects)

    const initSegment = {
      data: event.data.track.initSegment.buffer,
      byteOffset: event.data.track.initSegment.byteOffset,
      byteLength: event.data.track.initSegment.byteLength
    };
    const boxes = {
      data: event.data.boxes.buffer,
      byteOffset: event.data.boxes.byteOffset,
      byteLength: event.data.boxes.byteLength
    };
    const segment = {
      boxes,
      initSegment,
      type: event.type,
      sequence: event.data.sequence
    };

    if (typeof event.data.videoDts !== 'undefined') {
      segment.videoDtsTime = event.data.videoDts / ONE_SECOND_IN_TS;
    }

    window.postMessage({
      action: 'data',
      segment
    }, [ segment.boxes.data, segment.initSegment.data ]);
  });

  // TODO add support for captionStream
  if (transmuxer.captionStream) {
    transmuxer.captionStream.on('data', function(caption) {
      window.postMessage({
        action: 'caption',
        data: caption
      });
    });
  }

  transmuxer.on('done', function(data) {
    window.postMessage({
      action: 'done',
      type: typeFromStreamString(data)
    });
  });

  transmuxer.on('partialdone', function(data) {
    window.postMessage({
      action: 'partialdone',
      type: typeFromStreamString(data)
    });
  });

  transmuxer.on('endedsegment', function(data) {
    window.postMessage({
      action: 'endedSegment',
      type: typeFromStreamString(data)
    });
  });

  transmuxer.on('gopInfo', function(gopInfo) {
    window.postMessage({
      action: 'gopInfo',
      gopInfo
    });
  });

  transmuxer.on('trackinfo', function(trackInfo) {
    window.postMessage({ action: 'trackinfo', trackInfo });
  });

  transmuxer.on('audioTimingInfo', function(audioTimingInfo) {
    window.postMessage({
      action: 'audioTimingInfo',
      audioTimingInfo: {
        start: audioTimingInfo.start / ONE_SECOND_IN_TS,
        end: audioTimingInfo.end / ONE_SECOND_IN_TS
      }
    });
  });

  transmuxer.on('videoTimingInfo', function(videoTimingInfo) {
    window.postMessage({
      action: 'videoTimingInfo',
      videoTimingInfo: {
        start: videoTimingInfo.start / ONE_SECOND_IN_TS,
        end: videoTimingInfo.end / ONE_SECOND_IN_TS
      }
    });
  });
};

/**
 * All incoming messages route through this hash. If no function exists
 * to handle an incoming message, then we ignore the message.
 *
 * @class MessageHandlers
 * @param {Object} options the options to initialize with
 */
class MessageHandlers {
  constructor(options) {
    this.options = options || {};
    this.init();
  }

  /**
   * initialize our web worker and wire all the events.
   */
  init() {
    if (this.transmuxer) {
      this.transmuxer.dispose();
    }
    this.transmuxer = this.options.handlePartialData ?
      new partialMux.Transmuxer(this.options) :
      new fullMux.Transmuxer(this.options);

    if (this.options.handlePartialData) {
      wirePartialTransmuxerEvents(this.transmuxer);
    } else {
      wireFullTransmuxerEvents(this.transmuxer);
    }
  }

  /**
   * Adds data (a ts segment) to the start of the transmuxer pipeline for
   * processing.
   *
   * @param {ArrayBuffer} data data to push into the muxer
   */
  push(data) {
    // Cast array buffer to correct type for transmuxer
    let segment = new Uint8Array(data.data, data.byteOffset, data.byteLength);

    this.transmuxer.push(segment);
  }

  /**
   * Set the value that will be used as the `baseMediaDecodeTime` time for the
   * next segment pushed in. Subsequent segments will have their `baseMediaDecodeTime`
   * set relative to the first based on the PTS values.
   *
   * @param {Object} data used to set the timestamp offset in the muxer
   */
  setTimestampOffset(data) {
    let timestampOffset = data.timestampOffset || 0;

    this.transmuxer.setBaseMediaDecodeTime(
      Math.round(timestampOffset * ONE_SECOND_IN_TS));
  }

  setAudioAppendStart(data) {
    this.transmuxer.setAudioAppendStart(Math.ceil(data.appendStart * ONE_SECOND_IN_TS));
  }

  /**
   * Forces the pipeline to finish processing the last segment and emit it's
   * results.
   *
   * @param {Object} data event data, not really used
   */
  flush(data) {
    this.transmuxer.flush();
    // transmuxed done action is fired after both audio/video pipelines are flushed
    window.postMessage({
      action: 'done',
      type: 'transmuxed'
    });
  }

  partialFlush(data) {
    this.transmuxer.partialFlush();
    // transmuxed partialdone action is fired after both audio/video pipelines are flushed
    window.postMessage({
      action: 'partialdone',
      type: 'transmuxed'
    });
  }

  endTimeline() {
    this.transmuxer.endTimeline();
    // transmuxed endedtimeline action is fired after both audio/video pipelines end their
    // timelines
    window.postMessage({
      action: 'endedtimeline',
      type: 'transmuxed'
    });
  }

  reset() {
    this.transmuxer.reset();
  }

  alignGopsWith(data) {
    this.transmuxer.alignGopsWith(data.gopsToAlignWith.slice());
  }
}

/**
 * Our web wroker interface so that things can talk to mux.js
 * that will be running in a web worker. the scope is passed to this by
 * webworkify.
 *
 * @param {Object} self the scope for the web worker
 */
const TransmuxerWorker = function(self) {
  self.onmessage = function(event) {
    if (event.data.action === 'init' && event.data.options) {
      this.messageHandlers = new MessageHandlers(event.data.options);
      return;
    }

    if (!this.messageHandlers) {
      this.messageHandlers = new MessageHandlers();
    }

    if (event.data && event.data.action && event.data.action !== 'init') {
      if (this.messageHandlers[event.data.action]) {
        this.messageHandlers[event.data.action](event.data);
      }
    }
  };
};

export default (self) => {
  return new TransmuxerWorker(self);
};
