/*  join.js
    
    Distributable incremental joins.
    
    Joins are a major feature of relational databases, and a consequence of normalization.
    Most charded, and so-called NoSQL, databases try to avoid joins favoring denormalized
    schemas. The idea of building applications with no joins at all is very attractive
    and provides for simplified programming while greatly simplifying charded database
    implementations.
    
    However, some applications cannot be practically designed with no joins at all, and
    in some cases, the resulting duplication of data can become detrimental to desirable
    network performance especially over the internet between a mobile client and a server.
    
    For these reasons, XS comes with joins that can be used both server-side, for complex
    applications, and client-side to optimize network performance and data caching.
    
    Designing efficient joins for these complex applications and allowing horizontal
    distribution aka charding is a significant challenge that this library addresses.
    
    The other significant difficulty is that XS is an incremental database, and that
    therefore this implementation must update a join set incrementally and efficiently,
    when either of the joined sets changes.
    
    To simplify the implementation we split the join between two sets into two half-joins.
    Each half join maintains an ordered representation of one of the sets which is used
    as a filter to the other set. A Union of these two half-joins provides for join.
    
    Each half join is therefore stateful for one of the sets and stateless for the
    other. The stateful part destination is not used as it only serves as a dynamic
    filter for the statless part. The only destination of the half-join is therefore
    that of the stateless part which means that the half join can be considered
    stateless and therefore easily distributed horizontally.
    
    When the filter of a half-join changes, there is no update emited. This would be
    incorrect if the other half join was not implemented simultaneously to form a
    proper join.
    
    ----
    
    Copyright (C) 2013, Connected Sets

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as
    published by the Free Software Foundation, either version 3 of the
    License, or (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
"use strict";

( function( exports ) {
  var XS;
  
  if ( typeof require === 'function' ) {
    XS = require( './xs.js' ).XS;
    
    require( './code.js'    );
    require( './pipelet.js' );
    require( './order.js'   );
  } else {
    XS = exports.XS;
  }
  
  var xs         = XS.xs
    , log        = XS.log
    , extend     = XS.extend
    , Code       = XS.Code
    , Pipelet    = XS.Pipelet
  ;
  
  /* -------------------------------------------------------------------------------------------
     de&&ug()
  */
  var de = true;
  
  function ug( m ) {
    log( "xs join, " + m );
  } // ug()
  
  /* -------------------------------------------------------------------------------------------
     a.join( b, on, merge, options )
     
     Parameters:
       - b: (pipelet) to join with a (the source)
       - on: (Array of conditions) the condition of the join
       - merge: function( values ) where values is an Array of values and where each value is
                an Array where the first element corresponds to joined values from the a set
                and the second corresponds to joined values from the b set. For a left join,
                the second element can be missing. For right joins, the first element may
                be undefined.
       - options: (Object):
         - left : (boolean) all values from a will produce at least one merged value even if
                  there are no matching value in b
         - right: (boolean) all values from b will produce at least one merged value even if
                  there are no matching value in a
         - outer: (boolean) means right and left join
     
     The 'on' condition is an Array of and-conditions, i.e. all conditions must be met for the
     on condition to succeed. Each condition applies to individual attributes of the source set
     or the 'b' set. A condition can be specified as:
       - a string representing the name of an attribute present in both a and b. The condition
         matches for all values for which the attribute name has the same value in a and b.
       - an Array of two attribute names, where the fist element is an attribute name in a
         and the second an attribute name in b. The condition matches for values where there the
         values of these respective attributes in a and b are equal.
         
     Example: add employee's first name and last name to sales from employee_id left joined on
       employee's id:
       
       sales.join( employees, [ [ 'employee_id', 'id' ] ], function( sale, employee ) {
         return extend( {
           employee_first_name: employee.first_name,
           employee_last_name : employee.last_name
         }, sale );
       }, { left: true } )
  */
  XS.Compose( 'join', function( a, b, on, merge, options ) {
    if ( options.outer ) {
      options = extend( { left: true, right: true }, options );
    }
    
    var options_a = options.left  ? extend( { all: true }, options ) : options
      , options_b = options.right ? extend( { all: true }, options ) : options
    ;
    
    var _a = a.half_join( 0, b, on, merge, options_a );
    var _b = b.half_join( 1, a, on, merge, options_b );
    
    return xs.union( [ _a, _b ], options );
  } );
  
  /* -------------------------------------------------------------------------------------------
     Half_Join( position, filter, on, merge, options )
  */
  function Half_Join( position, filter, on, merge, options ) {
    Pipelet.call( this, options );
    
    this.position = position;
    this.merge = merge;
    
    this.make_organizer_and_transform( position, on );
    
    this.filter = filter.order( this.organizer, this.options );
    
    // fetch should use only one of the half-joins => disable fetch on the right half-join
    if ( position ) {
      if ( this.options.all ) {
        this.fetch = function( receiver ) {
          // This is a right outer join
          // We need to include right values which have no left match
          var that = this;
          
          this.only_not_matching = true;
          
          Pipelet.prototype.fetch.call( this, function( values, end ) {
            if ( end ) that.only_not_matching = false;
            
            receiver( values, end );
          } );
          
          return this;
        }
      } else {
        this.fetch = function( receiver ) {
          // This is an inner join or a left outer join
          // We do not need to provide any right value because all matching right values will be included from the left half-join
          receiver( void 0, true );
          
          return this;
        }
      }
    }
    
    return this;
  } // Half_Join()
  
  Pipelet.build( 'half_join', Half_Join, {
    make_organizer_and_transform: function( position, on ) {
      var organizer = this.organizer = [], attributes = [], renames = 0;
      
      for ( var i = -1, l = on.length; ++i < l; ) {
        var c = on[ i ];
        
        switch( typeof c ) {
          case 'string':
            organizer.push( { id: c } );
            
            attributes.push( c + ': v.' + c );
          break;
          
          case 'object':
            if ( c instanceof Array ) {
              var id = c[ position ^ 1 ];
              
              organizer.push( { id: id } );
              
              attributes.push( id + ': v.' + c[ position ] );
              
              renames++;
            }
          break;
        }
      }
      
      var u, all = this.options.all;
      
      var transform = new Code( 'join..transform(), position: ' + position + ', all: ' + all )
        ._function( 'this.transform', u, [ 'values' ] )
          ._var( 'u', 'filter = this.filter', 'merge = this.merge', 'out', 'i', 'l', 'v', 'locations' );
          
          if ( renames ) {
            attributes = '{ __v: v = values[ ++i ], ' + attributes.join( ', ' ) + ' }';
            
            transform
              .add( 'out = []; l = values.length; i = -1' )
            
              .unrolled_while( 'out.push( ' + attributes, ', ' + attributes, ')' )
              
              .add( 'values = out' )
            ;
          } else {
            transform.add( 'values = values.slice( 0 )' ); // Shallow copy before sort
          }
          
          var merge = 'merge( ' + ( position ? 'matches[ ++j ], v' : 'v, matches[ ++j ]' ) + ' )';
          
          transform
          .add( 'out = []; i = -1' )
          
          .add( 'values.sort( filter.organizer )' )
          
          ._if( 'this.only_not_matching' )
            .add( 'locations = filter.locate( values ); l = locations.length' )
            
            ._while( '++i < l' )
              ._var( '_l = locations[ i ]', 'v = _l.o' + ( renames ? '.__v' : '' ) )
              
              ._if( '_l.found === u' )
                //.add( 'out.push( merge( ' + ( position ? 'u, v' : 'v' ) + ' ) )' )
              .end()
            .end()
            
            .add( 'return out' )
          .end()
          
          .add( 'locations = filter.locate( values, { all: true } ); l = locations.length' )
          
          // Merge joined values
          ._while( '++i < l' )
            ._var( '_l = locations[ i ]', 'v = _l.o' + ( renames ? '.__v' : '' ), 'matches = _l.all_matches' )
            
            ._if( 'matches' )
              ._var( 'j = -1, ml = matches.length' )
              
              .unrolled_while(
                'out.push( ' + merge, ', ' + merge, ')', { index: 'j', l: 'ml' }
              );
              
            all && transform._else().add( 'out.push( merge( ' + ( position ? 'u, v' : 'v' ) + ' ) )' )
              
              transform
            .end()
          .end()
          
          .add( 'return out' )
        .end( 'transform' )
      ;
      
      eval( transform.get() );
      
      return this;
    } // make_organizer_and_transform()
  } ); // Half_Join instance methods
  
  /* --------------------------------------------------------------------------
     module exports
  */
  eval( XS.export_code( 'XS', [ 'Half_Join' ] ) );
  
  de&&ug( "module loaded" );
} )( this ); // join.js
