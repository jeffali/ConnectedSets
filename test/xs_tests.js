// Generated by CoffeeScript 1.4.0
(function() {
  var XS, chai;

  if (typeof require !== "undefined" && require !== null) {
    XS = require('../src/xs.js');
  }

  if (typeof require !== "undefined" && require !== null) {
    chai = require('chai');
  }

  if (chai != null) {
    chai.should();
  }

  describe('XS test suite:', function() {
    return it('XS should be defined:', function() {
      return XS.should.be.exist;
    });
  });

}).call(this);
