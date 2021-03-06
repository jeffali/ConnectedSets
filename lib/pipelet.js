/*  pipelet.js
    
    Pipelet base classes:
      - Pipelet: the current base of all pipelet classes having one source and one
        destination
      - Fork: a Pipelet with one source and n destinations
      - Union: a Pipelet with n sources and one destination
      - Set: a stateful set implementation
    
    Also defines the 'xs' namespace for a fluid interface that acts as a singleton
    or a pseudo source.
    
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
    
    require( './code.js' );
  } else {
    XS = exports.XS;
  }
  
  var log        = XS.log
    , extend     = XS.extend
    , subclass   = XS.subclass
    , Code       = XS.Code
    , u
  ;
  
  var push = Array.prototype.push
    , slice = Array.prototype.slice
    , concat = Array.prototype.concat
  ;
  
  /* -------------------------------------------------------------------------------------------
     de&&ug()
  */
  var de = true;
  
  function ug( m ) {
    log( "xs pipelet, " + m );
  } // ug()
  
  /* -------------------------------------------------------------------------------------------
     Pipelet( options )
     
     A Pipelet has one upstream source and one downstream pipelet.
     
     Parameters:
       options: optional object:
         - key: unique key for values, default is [ 'id' ]
         
     This is the base class of all Pipelets, Forks and Union, providing the building block of
     all XS applications. 
     
     Pipelets process the basic Operations add, remove, and clear coming from their source set
     and producing their destination set. An update operation is an optimization that groups a
     remove and an add operation into a single operation.
     
     Operations can be combined to form transactions. Operations may contain a 'more' options to
     indicate that more operations should be expected as part of a transaction. The more option
     should be propagated by most pipelets and allows to optimize certain updates by grouping a
     number of operations that may take different paths to reach a particular pipelet. If the
     more option is discarded the only consequence should be that these optimisations could not
     be performed, possibly resulting in performance issues.
     
     Pipelets can be distributed vertically, or horizontally. Vertical distribution is when
     a individual pipelets run on different processes or servers but each pipelet is executed
     entirely within the same thread. Horizontal distribution, aka charding, is when a single
     pipelet's execution is run over several threads and/or processes and/or servers.
     
     To ease horinzontal distribution, an important aspect of XS operations is that these can
     be executed in any order. In other words, the final state of a set does not depend on the
     order of execution of individual operations. This means that a remove operation can be
     executed before an add.
     
     Consistency of distributed sets is 'eventual' and performed by conflict resolution agents,
     i.e. Excess provides high availability and partition tolerence by delaying consistency. 
     
     Pipelets can be stateless or stateful:
     
     Stateless Pipelet:
     -----------------
     A Stateless pipelet does not hold any state between operations and can be seen as purely
     functional.
     
     Stateless pipelets do not require memory between operations, and are therefore for the
     most part CPU-bound.
     
     The order in which operations are processed does not matter and it can therefore be
     distributed horizontally at any time.
     
     Examples of statefull pipelets are: Fork, Union, and Filter.
     
     Forks and Union can be distributed in hierarchical trees.
     
     A Fork can be distributed into a head fork, connected to many indepedent forks.
     Likewise a Union can be distributed into many independent unions connected to a tail
     union. This hierarchy can have any depth allowing scalability to billions of branches
     over as many processes and machines as required.
     
     Stateless pipelets must implement the transform( values ) method that returns values
     as transformed or filtered. This method is then used by provided add(), remove(),
     , and update() operation methods to produce the desintation set plus the fetch()
     method invoqued when a destination pipelet connects its source to a stateless pipelet.
     
     Stateful Pipelet:
     ----------------
     A Stateful pipelet maintains the state of the set either in memory or on mass storage.
     
     Stateful pipelets may be distributed horizontally if it has at least two stages: a
     map stage and a merge stage. The map stage must be able to work on a subset of the set
     accepting operations in any order. The merge stage reduces results of subsets into
     a new subset that may be further reduced in a hierachical merge until a tail merge
     produces the output set of the pipelet.
     
     Sateful pipelets must implement fetch(), add(), remove(), update(), and clear() and
     propagate their state forward using emit_xxx() methods where xxx is one of add, remove
     update, or clear.
     
     Stateful pipelets must be able to process add, remove and update operations in any
     order to allow horizontal distribution of other pipelets. This means that stateful
     pipelets must implement an 'anti-state' to memorize removes and updates that are
     received before a matching add.
     
     The anti-state is compensated by add or update operations received 'soon' after and
     therefore the anti-state should be empty most of the time. The anti-state can therefore
     be considered transitional. If operations remain in the anti-state for a 'long' time,
     this may indicate a conflict or the prolonged unavailability of a node and all of its
     replicas.
     
     Emited operations (emit_xxx) may emit duplicate adds (two or more add operations for
     the same key) but should not emit removes stored in their anti-state.
     
     Conflict Detection:
     ------------------
     A stateful pipelet may be used for detect conflicts. Conflicts happen when:
       - Two or more add operations have the same key
       - A remove or update operation does not find a matching value
     
     Conflict detection can be differentiated from unordered operations because unordered
     operations are transitional and should be compensated 'soon' after these are received.
     
     'soon' may go from milliseconds in the closed context of multi-process distribution on a
     non-overloaded single machine, to over ten minutes in a catastrophic event where all
     replicas of a chard are temporarily unavailable.
     
     Therefore conflict can be detected faster if the state of availability of all chards
     is known by the conflict detector.
     
     A conflict detection pipelet would emit 'conflicts' using enit_add(). A conflict
     contains:
       - The content of operation that led to the conflict
       - all meta-information for this operation such as user ids, timestamps, etc..
       
     Once the conflict is resolved, through add, remove, and update operations, the conflict
     detection pipelet emits a remove opetation on the conflict. All conflicts are resolved
     when the size of the resulting conflict set is zero.
       
     Conflict Resolution:
     -------------------
     Conflict resultion is performed by agents processing conflits, with or without the help
     of users of the system.
     
     The most simple and automatic conflict resolution agent reverts all conflicts
     operations:
       - add become remove
       - remove become add
       - update is reverted, i.e. previous and new values are swapped
       
     Persistance:
     -----------
     Persistance is achieved using stateful pipelets that store all operations into some mass
     storage.
     
     These operations can be stored in any order over many chards maintained by many
     independent servers.
     
     Upon storing transactions, meta-information can be added such as timestamps and user ids.
     
     Replication:
     -----------
     Replication is achieved by persisting the same set of operations over more than one set
     of chards.
     
     Initialisation and restart synchronisation between replicas may be optimized using
     timestamps allowing to fetch a subset of set.
     
     Data Versionning:
     ----------------
     Because persistance is achived by storing all operations, all previous versions of all
     objects can be reconstructed.
     
     Reconstruction can be done forward by processing operations in storage order, or
     backward by reverting operations in reverse storage order.
     
     Compaction and Version Discarding:
     ---------------------------------
     For performance and privacy issues, it may be desirable to dicard past versions of
     objects on all replicas. This can be achieved by several strategies:
     
     - Full compacting, by storing the current state and anti-state of a chard. Doing
       so, all meta information of the orginal operations will most likely be discarded.
     
     - Selective object(s) compacting, by combining a number of operations into either
       a single add operation corresponding to the last update for that object or the
       complete removal of all operations if the last operation is remove. This method
       can be used to preserve timestamps and other meta-data by using that of the last
       update.
     
     Snapshots:
     ---------
     A snapshot is a point-in-time copy of the a database. It can be achieved using
     operations timestamps by copying the content of all chards up to that timestamp.
     
     During snapshots, compaction must be delayed.
  */
  function Pipelet( options ) {
    this.options = options = options || {};
    
    this.key = options.key || [ 'id' ];
    
    this.source = this.destination = u; // No source or desination yet
    
    return this;
  } // Pipelet()
  
  var p = Pipelet.prototype;
  
  extend( p, {
    /* ------------------------------------------------------------------------
       fetch( receiver )
       
       Fetches the content of this set, possibly in chunks.
       
       This is the stateless version, it must be overloaded by stateful
       pipelets. 
       
       Parameter:
         - receiver: function that will be called for each chunk of data and
           which signature is  receiver( values, no_more ):
             - values: (Array) of values for each chunk
             
             - no_more: indicated the last chunk if truly 
    */
    fetch: function( receiver ) {
      var that = this;
      
      return this._fetch_source( function( values, no_more ) {
        if ( values && values.length ) values = that.transform( values );
        
        receiver( values, no_more );
      } );
    }, // fetch()
    
    /* ------------------------------------------------------------------------
       _fetch_source( receiver )
       
       Fetches the content of this source set, possibly in chunks.
       
       This method should only be used by derived classes.
       
       Parameter:
         - receiver: (function) see fetch() for definition 
    */
    _fetch_source: function( receiver ) {
      var u, s = this.source;
      
      if ( s ) {
        s.fetch( receiver );
      } else {
        receiver( u, true ); // No source, so this is an empty set
      }
      
      return this;
    }, // _fetch_source()
    
    /* ------------------------------------------------------------------------
       fetch_all( [ receiver ] )
       
       Fetches the entire content of the source set.
       
       This method should only be used for debugging and testing purposes or
       when the full state is known to be 'small' (can fit entirely in memory).
       
       For large sets, use fetch() instead that allows to retreive the content
       in 'resonable' size chunks that all fit in memory.
       
       Parameter:
         - receiver: (optional function) see fetch() for definition.
           
           This function must be provided if the source is not in the same
           process or worker thread. Otherwise an exception will be raised.
           
       Returns:
         Undefined: the source is not in the same process or worker thread,
           therefore the result is assynchronous and cannot be known at the
           time when fetch_all() returns.
         
         Array of values: the source is in the same process or worker thread,
           the fetch_all() method is therefore synchronous and the returned
           value contains the Array of all the values of the set.
         
       Exceptions:
         If the method is asynhronous, because the source is in a different
         process or worker thread, and no receiver function is provided, an
         exception will be raised.
         
         If a chunk is received after the last chunk was received.
    */
    fetch_all: function( receiver ) {
      var that = this, u, out;
      
      if ( this.fetch === Pipelet.prototype.fetch ) {
        // fetch has not been overloaded so this is a stateless pipelet
        // Can optimize using _fetch_source_all() to do a single transform
        this._fetch_source_all( function( values, no_more ) {
          out = that.transform( values );
          
          receiver && receiver( out, no_more );
        } );
      } else {
        var chunks = [];
        
        this.fetch( function( values, no_more ) {
          if ( out ) throw new Error( "Pipelet..fetch_all(): received extra chunck after no_more" );
          
          if ( values && values.length ) chunks.push( values );
          
          if ( no_more ) {
            out = concat.apply( [], chunks );
            
            receiver && receiver( out, no_more );
          }
        } );
      }
      
      if ( out === u && receiver === u ) throw new Error( "Pipelet..fetch_all() is asynchronous and no receiver function was provided" );
      
      return out;
    }, // fetch_all()
    
    _fetch_source_all: function( receiver ) {
      var chunks = [], out, u;
      
      this._fetch_source( function( values, no_more ) {
        if ( out ) throw new Error( "Pipelet..fetch_all(): received extra chunck after no_more" );
        
        if ( values && values.length ) chunks.push( values );
        
        if ( no_more ) {
          out = concat.apply( [], chunks );
          
          receiver && receiver( out, no_more );
        }
      } );
      
      if ( out === u && receiver === u ) throw new Error( "Pipelet..fetch_all() is asynchronous and no receiver function was provided" );
      
      return out;
    }, // _fetch_source_all()
    
    /* ------------------------------------------------------------------------
       transform( values )
       
       Transforms an array of values into an other array of values according
       to the current pipelet role.
       
       Default is to return all values unaltered. Every pipelet should either
       implement transform() if it is stateless or fetch() if it is statefull
       and/or implement add(), remove(), and update().
       
       Paraemter:
         values: Array of values (javascript objects).
    */
    transform: function( values ) {
      return values;
    }, // transform()
    
    /* ------------------------------------------------------------------------
       notify( transaction [, options ] )
       
       Executes a transaction, eventually atomically (everything succeeds or
       everything fails).
       
       Parameters:
         - transaction: Array of actions. Each action has attributes:
           - action: string 'add', or 'remove', or 'update'
           - objects: Array of objects for 'add' and 'remove' or updates. An update
             is an Array where the first item is the previous object value and the
             second item is the new object value

         - options: optional object of optional attributes
         
       ToDo: manage atomic transcations, will rollback capability
    */
    notify: function( transaction, options ) {
      var l = transaction.length;
      
      for ( var i = -1; ++i < l; ) {
        var a = transaction[ i ].action;
        
        switch( a ) {
          case 'add':
          case 'remove':
          case 'update':
            if ( this[ a ] ) break;
          // fall-through
          
          default:
            throw( new Unsuported_Action( a ) );
        }
      }
      
      for ( var i = -1; ++i < l; ) {
        var a = transaction[ i ];
        
        this[ a.action ]( a.objects, options );
      }
      
      return this;
    }, // notify()
    
    /* ------------------------------------------------------------------------
       add( added [, options ] )
       
       Add objects to this pipelet then notify downstream pipelets.
       
       This method should only be called by the source pipelet.
       
       Unless there is no source, this function should not be called directly
       by users.
       
       This method is often overloaded by derived classes, the default
       behavior is to notify downstream pipelets using emit_add() of
       transformed objects by transform().
       
       Parameters:
         added: Array of object values to add
         
         option: optional object
    */
    add: function( added, options ) {
      return this.emit_add( this.transform( added, options ), options );
    }, // add()
    
    /* ------------------------------------------------------------------------
       emit_add( added [, options ] )
       
       Notify downsteam pipelets about added objects.
       
       This method is typically called by add() after adding objects.
       
       Users should not call this method directly.
       
       Parameters:
         added: Array of added objects
         
         option: optional object
    */
    emit_add: function( added, options ) {
      var d = this.destination;
      
      de&&ug( 'emit_add(), l: ' + added.length + ', d: ' + typeof d );
      
      d && d.add( added, options );
      
      return this;
    }, // emit_add()
    
    /* ------------------------------------------------------------------------
       update( updated [, options ] )
       
       Updates objects from this pipelet then notify downstream pipelets.
       
       This method should only be called by the source pipelet.
       
       Unless there is no source, this function should not be called directly by
       users.
       
       This method is often overloaded by derived classes, the default
       behavior is to notify downstream pipelets using emit_update() of
       transformed objects by transform().
       
       If the transform does not return as many values as there are updates,
       this transform uses emit_remove() and emit_add() to perform the
       update.
       
       Parameters:
         updated: Array of updates, each update is an Array of two objects:
           - the first is the previous object value,
           - the second is the updated object value.
         
         option: optional object
    */
    update: function( updated, options ) {
      var l = updated.length, removed, added;
      
      if ( l === 1 ) {
        var update = updated[ 0 ];
        
        removed = this.transform( [ update[ 0 ] ], options );
        added   = this.transform( [ update[ 1 ] ], options );
        
        if ( removed.length === 1 && added.length === 1 ) {
          return this.emit_update( [ [ removed[ 0 ], added[ 0 ] ] ], options );
        }
      } else {
        updated = Pipelet.split_updates( updated );
        
        removed = this.transform( updated.removed, options );
        added   = this.transform( updated.added  , options );
        
        if ( removed.length === l && added.length === l ) {
          var out = [];
          
          for( var i = -1; ++i < l; ) {
            out.push( [ removed[ i ], added[ i ] ] );
          }
          
          return this.emit_update( out, options );
        }
      }
      
      this.emit_remove( removed, options );
      this.emit_add   ( added  , options );
      
      return this;
    }, // update()
    
    /* ------------------------------------------------------------------------
       emit_update( updated [, options ] )
        
       Notify downsteam pipelets of updated object values.
       
       This method is typically called by update() after updating objects.
       
       Users should not call this method directly.
       
       Parameters:
         updated: Array of updates, each update is an Array of two objects:
           - the first is the previous object value,
           - the second is the updated object value.
         
         option: optional object
    */
    emit_update: function( updated, options ) {
      var d = this.destination;
      
      de&&ug( 'emit_update(), l: ' + updated.length + ', d: ' + typeof d );
      
      d && d.update( updated, options );
      
      return this;
    }, // emit_update()
    
    /* ------------------------------------------------------------------------
       remove( removed [, options ] )
       
       Removes objects from this pipelet then notify downstream pipelets.
       
       This method should only be called by the source pipelet.
       
       Unless there is no source, this function should not be called directly by
       users.
       
       This method is often overloaded by derived classes, the default
       behavior is to notify downstream pipelets using emit_remove() of
       transformed objects by transform().
       
       Parameters:
         removed: Array of object values to remove
         
         option: optional object
    */
    remove: function( removed, options ) {
      return this.emit_remove( this.transform( removed, options ), options );
    }, // remove()
    
    /* ------------------------------------------------------------------------
       emit_remove( removed [, options ] )
       
       Notify downsteam pipelets of removed object.
       
       This method is typically called by remove() after removing objects.
       
       Users should not call this method directly.
       
       Parameters:
         - removed: Array of removed object values.
         
         option: optional object
    */
    emit_remove: function( removed, options ) {
      var d = this.destination;
      
      de&&ug( 'emit_remove(), l: ' + removed.length + ', d: ' + typeof d );
      
      d && d.remove( removed, options );
      
      return this;
    }, // emit_remove()
    
    /* ------------------------------------------------------------------------
       clear( [ options ] )
       
       Clears the content of this Pipelet and downstream pipelets.
       
       clear() is usually called when an update requires to clear the state of all
       downstream objects. This is typically done when:
         - when a stream is no longer needed and memory can be reclaimed;
         - all or most values will change and it is more efficient to clear;
         - the state of downstream objects cannot be updated incremetally;
       .
       
       Parameters:
         option: optional object
    */
    clear: function( options ){
      return this.emit_clear( options );
    }, // clear()
    
    /* ------------------------------------------------------------------------
       emit_clear( [ options ] )
       
       Notify downsteam pipelets that all object values should be cleared.
       
       This method is typically called by clear() for clearing downstream objects.
       
       Users should not call this method directly.

       Parameters:
         option: optional object
    */
    emit_clear: function( options ) {
      var d = this.destination;
      
      de&&ug( 'emit_clear(), d: ' + typeof d );
      
      d && d.clear( options );
      
      return this;
    }, // emit_clear()
    
    /* ------------------------------------------------------------------------
       add_source( source [, options ] )
       
       Connect this pipelet to an upstream source pipelet.
       
       The content of the source is then fetched and added ot this pipelet.
       
       Parameters:
         - source: (Pipelet) the source pipelet or any other object to connect
                   to.
         
                   If source is an not an instance of Pipelet, it's content is
                   only added to the current pipelet using this.add(). It is
                   typically an Array but could be any other object type that
                   this.add() supports such as a function.
           
         - options: (Object):
           - no_add: do not add() values from source.
                     This option is used by _add_destination() to prevent
                     adding values to the first destionation while creating a
                     fork() for a second destination.
    */
    add_source: function( source, options ) {
      if ( source.is_void ) return this;
      
      var that = this, connected;
      
      if ( options && options.no_add ) return connect();
      
      if ( source.fetch ) {
        source.fetch( function( values, no_more ) {
          if ( values && values.length ) that.add( values );
          
          if ( no_more ) connect();
        } );
      } else {
        this.add( source );
        connect();
      }
      
      return this;
      
      function connect() {
        if ( connected ) {
          throw new Error( 'Pipelet.add_source(), connect(): already connected, no_more received twice from fetch()' );
        }
        connected = true;
        
        source._add_destination && source._add_destination( that );
        return that._add_source( source );
      }
    }, // add_source()
    
    /* ------------------------------------------------------------------------
       _add_source( source )
       
       Sets the source pipelet for this pipelet or remove it if source is
       undefined.
       
       This is a low-level method that should not be used by external objects
       because it does not add a destination to the source pipelet.
       
       This method can be overloaded by derived classes to:
         - change the implementation of source
         - reject the addition by generating an exception.
         - trigger other actions on addition
       
       Paramters:
         - source: the source pipelet to add or undefined to remove the source.
    */
    _add_source: function( source ) {
      var s = this.source;
      
      if ( s ) {
        if ( ! ( s instanceof Union ) ) {
          this.source = s = xs
            .union()
            ._add_destination( this )
            ._add_source( s )
          ;
        }
        s._add_source( source );
      } else {
        this.source = source;
      }
      
      return this;
    }, // _add_source()
    
    /* ------------------------------------------------------------------------
       _add_destination( destination )
       
       Adds a destination pipelet to this pipelet.
       
       This is a low-level method that should not be used by external objects
       because it does not add the source of the destination pipelet so
       added.
       
       This method can be overloaded by derived classes to:
         - change the implementation of destionation(s)
         - reject the addition by generating an exception.
         - trigger other actions on addition
       
       Paramters:
         - destination: the destination pipelet to add 
    */
    _add_destination: function( destination ) {
      var u, d = this.destination;
      
      if ( d ) {
        if ( ! ( d instanceof Fork ) ) {
          // Create a fork then add current destination
          this.destination = u;
          d = ( this.fork( u, { no_add: true } ) )._add_destination( d );
        }
        d._add_destination( destination );
      } else {
        this.destination = destination;
      }
      
      return this;
    }, // _add_destination()
    
    /* ------------------------------------------------------------------------
       remove_source( source )
       
       Disconnects an upstream source pipelet from this pipelet.
       
       Calls low-level _remove_destination() and _remove_source() to remove the
       bidirectional link between the two pipelets.
       
       Parameters:
         - source: (Pipelet) the source pipelet to remove 
    */
    remove_source: function( s ) {
      // disconnect from upstream source pipelet
      s._remove_destination && s._remove_destination( this );
      
      this._remove_source( s );
      
      return this;
    }, // remove_source()
    
    /* ------------------------------------------------------------------------
       _remove_source( source )
       
       Removes an upstream source pipelet from this pipelet.
       
       This is a low-level method that should not be called directly but can be
       overloaded.
       
       Parameters:
         - source: (Pipelet) to remove from this pipelet
         
       Exception:
         - source is not a source of this pipelet
    */
    _remove_source: function( p ) {
      var u, s = this.source;
      
      if ( s ) {
        if ( s instanceof Union ) {
          s._remove_source( p );
        } else {
          this.source = u;
        }
      } else {
        throw new Error( 'Pipelet._remove_source( source ), source is not this.source' );
      }
      
      return this;
    }, // _remove_source()
    
    /* ------------------------------------------------------------------------
       _remove_destination( destination )
       
       Removes a destination pipelet to this pipelet.
       
       This is a low-level method that should not be used by external objects
       because it does not remove the source of the destination pipelet so
       removed.
       
       This method can be overloaded by derived classes to:
         - change the implementation of destionation(s)
         - reject the removal by generating an exception.
         - trigger other actions on removal
       
       Paramters:
         - destination: the destionation pipelet to remove 
         
       Exception:
         - destination is not a known destination of this pipelet
    */
    _remove_destination: function( p ) {
      var u, d = this.destination;
      
      if ( d ) {
        if ( d instanceof Fork ) {
          d._remove_destination( p );
        } else {
          this.destination = u;
        }
      } else {
        throw new Error( 'Pipelet._remove_destination( destination ), destination is not this.destination' );
      }
      
      return this;
    }, // _remove_destination()
    
    /* ------------------------------------------------------------------------
       make_key( object )
       
       Use this.key to generate code JIT to return a unique a string for an
       object based on the key coordinates concatenation separated with '#'.
       
       Parameters:
         object: an object which key is requested.
    */
    make_key: function( o ) {
      var key = this.key, l = key.length, code = [];
      
      for ( var i = -1; ++i < l; ) code.push( 'o.' + key[ i ] );
      
      eval( new Code()
        ._function( 'this.make_key', null, [ 'o' ] )
          .add( "return '' + " + code.join( " + '#' + " ) )
        .end( 'make_key()' )
        .get()
      );
      
      return this.make_key( o );
    } // make_key()
  } ); // Pipelet instance methods
  
  /* --------------------------------------------------------------------------
    The xs object is a void source Pipelet to provide a fluid interface with a
    namespace for other Pipelets.
    
    Example:
      Publish a sales dataset from a 'sales' file:
      
      xs.file( 'sales' ).publish();
      
      The xs objects acts a namespace for XS chainable pipelets. Without the xs
      object, one would have to write the following less fluid code where the
      xs namespace is not explicit and requiring the new operator on a class to
      create the fist pipelet of a chain:
      
      new File( 'sales' ).publish();
  */
  var xs = new Pipelet();
  
  // Prevent becoming a source of any downstream Pipelet, see Pipelet.prototype.add_source()
  xs.is_void = true;
  
  // Pipelet Class methods
  
  /* -------------------------------------------------------------------------------------------
     Pipelet.split_updates( updates )
     
     Split updates into removed and added arrays. Use this function to process updates as if
     these were removals followed by additions into a set.
     
     Parameters:
       - updates: (Array) updates where an update is an Array of two values:
         - position 0: a previous value, corresponding to a removal
         - position 1: a new value corresponding to an addition 
     
     Returns an object with attributes:
       - removed: (Array of values)
       - added  : (Array of values)
  */
  Pipelet.split_updates = function( updates ) {
    var l = updates.length, update;
    
    if ( l === 1 ) {
      update = updates[ 0 ];
      
      return { removed: [ update[ 0 ] ], added: [ update[ 1 ] ] };
    }
    
    var removed = [], added = [];
    
    for( var i = -1; ++i < l; ) {
      update = updates[ i ];
      
      removed.push( update[ 0 ] );
      added  .push( update[ 1 ] );
    }
    
    return { removed: removed, added: added };
  }; // split_updates()
   
  /* -------------------------------------------------------------------------------------------
     Pipelet.add( name, pipelet )
     
     Add a pipelet method to the Pipelet base class.
     
     Parameters:
       - name   : (string) the name of the pipelet
       - pipelet: (function) the method.
  */
  Pipelet.add = function( name, pipelet ) {
    return Pipelet.prototype[ name ] = pipelet;
  };
  
  /* -------------------------------------------------------------------------------------------
     Pipelet.set_default_options( source, parameters, f )
     
     Set default options for pipelet parameters.
     
     Returns an Array of parameters with default options as the last parameter.
     
     Parameters:
       - f          : (function) Pipelet constructor or composition function which last parameter
                      must always be options
       - source     : (Pipelet instance) source pipelet
       - parameters : (arguments) from pipelet invocation, the last of which is considered options
                      if is at the same position as the options parameter of f (f.length - 1)
  */
  Pipelet.set_default_options = function( f, source, parameters ) {
    parameters = slice.call( parameters, 0 );
    
    var options = { key: source.key }
      , l = parameters.length
      , u
    ;
    
    if ( typeof f === 'function' && f.length !== u ) {
      if ( l === f.length ) {
        l -= 1;
        
        parameters[ l ] = extend( options, parameters[ l ] );
      } else if ( l < f.length ) {
        // Set options as last expected parameter of constructor or composition
        parameters[ f.length - 1 ] = options;
      } else {
        throw new Error( "Pipelet.set_default_options(), too many parameters provided for pipelet, expected " + f.length + " parameters max" );
      }
    } else {
      // ToDo: remove if not triggered in IE7+
      throw new Error( "Pipelet.set_default_options(), deprecated, must be called with function having function.length property" );
      
      if ( l ) {
        var last = parameters[ --l ];
        
        if ( typeof last === 'object'
          && ! ( last instanceof Array )
          && ! ( last instanceof Pipelet )
        ) {
          parameters[ l ] = extend( options, last );
        } else {
          parameters.push( options );
        }
      } else {
        parameters = [ options ];
      }
    }
    
    return parameters;
  }; // Pipelet.set_default_options()
  
  /* --------------------------------------------------------------------------
     Pipelet.subclass( constructor [, methods ] )
     
     - Makes constructor a subclass of This class
     - Add methods to constructor's prototype, if any
     - Add subclass() and build() class methods to constructor
     
     Parameters:
       - constructor: (function) a Pipelet constructor
     
     Optional Parameters:
       - methods    : (object) methods for the constructor's class
     
     Usage:
       Set.subclass( Order );
  */
  Pipelet.subclass = function( constructor, methods ) {
    subclass( this, constructor );
    
    // Allows build and subclass to be used by subclass
    constructor.build = Pipelet.build;
    constructor.subclass = Pipelet.subclass;
    
    methods && extend( constructor.prototype, methods );
  }; // Pipelet.subclass()
  
  /* --------------------------------------------------------------------------
     Pipelet.build( name, constructor [, methods [, pipelet ] ] ] )
     
     Pipelet builder:
       - Makes constructor a subclass of This class using This.subclass()
       - defines Pipelet[ name ] using generated code or pipelet function
       - add methods to constructor's prototype, if any
     
     Parameters:
       - name         : (string) the name of the pipelet
       - constructor  : (function) a Pipelet constructor which signature is:
         - parameters : 0 to n required parameters either Pipelet instances or
                        non-objects (numbers, strings, functions, booleans,
                        null, undefined)
         - options    : (object) optional parameters, will extend default
                        options
     
     Optional Parameters:
       - methods      : (object) methods for the constructor's class
       - pipelet      : (function) the pipelet function creating an instance
                        of the constructor's class.
       
     Example: a 'from_usa' pipelet that filters values which country attribute
     is 'USA'.
     
     Programmer:
        function From_USA( options ) {
          return Pipelet.call( this, options );
        }
        
        Pipelet.build( "from_USA", From_USA,
          { transform: function( values ) {
              var usa_values = [];
              
              for ( var i = 0; i < values.length; ) {
                var v = values[ i++ ];
                
                if ( v.country === 'USA' ) usa_values.push( v );
              }
              
              return usa_values;
            }
          } // methods
        );
        
     Architect Usage, displays sales from usa in a table:
       xs.file( 'sales' ).from_USA().table( '#sales_from_usa' );
  */
  Pipelet.build = function( name, constructor, methods, pipelet ) {
    this.subclass( constructor, methods );
    
    var u;
    
    if ( pipelet === u ) {
      pipelet = ( function() {
        function constructor_apply( a ) {
          // Pretend this object was created using new constructor() 
          this.constructor = constructor;
          
          // Call constructor as new would have
          var r = constructor.apply( this, a );
          
          // Return this if constructor did not return anything
          return r === u ? this: r;
        }
        
        constructor_apply.prototype = constructor.prototype;
        
        return function pipelet() {
          var a = arguments;
          
          de&&ug( 'pipelet.' + name + '(), parameters count: ' + a.length );
          
          a = Pipelet.set_default_options( constructor, this, a );
          
          var options = a[ a.length - 1 ];
          
          return new constructor_apply( a ).add_source( this, options );
        } // pipelet()
      } )();
    }
    
    Pipelet.add( name, pipelet );
    
    return constructor;
  }; // Pipelet.build()
  
  /* -------------------------------------------------------------------------------------------
     Compose( name, composition [, context / constructor] )
     
     Compose a pipelet from other pipelets.
     
     Parameters:
       - name        : (string) the name of the pipelet
       
       - composition : (function) returning a output Pipelet instance and which signature is:
         - in        : (pipelet) the input Pipelet instance to this pipelet
         - parameters: optional parameters to the pipelet coming from the invocation of
                       the pipelet
         - options   : comming from the pipelet options augmented with default options
         
       - context / constructor : used to call composition, if this is a function it is used
                                 as a class constructor which instance is the context. The
                                 constructor is created using the same parameters as the
                                 composition function.
     
     Example, Compose a filter with an aggregate:     
       1/ Create the composition using source as the first mandatory parameter and options
          as the last that can be shared between all pipelets of the composition:
       
         function aggregate_from( source, from, measures, dimensions, options ) {
           return source
             .filter   ( from, options )
             .aggregate( measures, dimensions, options )
           ;
         }
       
       2/ Build the pipelet:
       
         XS.Compose( 'aggregate_from', aggregate_from );
       
       3/ Use composed aggregate_from() to aggregates sales yearly from usa:
       
         xs.model( 'sales' )
           .aggregate_from( [{ country: 'USA'}], [{ id: 'sales'}], [{ id: 'year'}] )
         ;
       
  */
  function Compose( name, composition, context ) {
    return Pipelet.add( name, function() {
      var a = slice.call( arguments, 0 );
      
      a.unshift( this );
      
      a = Pipelet.set_default_options( composition, this, a );
      
      if ( typeof context === 'function' ) context = new context( a );
      
      return composition.apply( context, a );
    } );
  } // Compose()
  
  /* -------------------------------------------------------------------------------------------
     Fork( destinations, options )
     
     Forks a source into many destinations.
     
     Parameters:
       - destinations : (Array of Pipelets) initial destination pipelets
       - options      : (Object)
  */
  function Fork( destinations, options ) {
    Pipelet.call( this, options );
    
    this.destinations = [];
    
    if ( destinations ) {
      for( var i = -1; ++i < destinations.length; ) {
        var p = destinations[ i ];
        
        if ( p && p instanceof Pipelet ) p.add_source( this );
      }
    }
    
    return this;
  } // Fork()
  
  Pipelet.build( 'fork', Fork, {
    /* ------------------------------------------------------------------------
       emit_add( added [, options ] )
       
       Notify downsteam pipelets about added objects.
       
       Parameters:
         - added: Array of added objects
         
         - options: optional object
    */
    emit_add: function( added, options ) {
      var d = this.destinations, l = d.length;
      
      for ( var i = -1; ++i < l; ) d[ i ].add( added, options );
      
      return this;
    }, // emit_add()
    
    /* ------------------------------------------------------------------------
       emit_remove( removed [, options ] )
       
       Notify downsteam pipelets of removed object.
       
       Parameters:
         - removed: Array of removed object values.
         
         - options: optional object
    */
    emit_remove: function( removed, options ) {
      var d = this.destinations, l = d.length;
      
      for ( var i = -1; ++i < l; ) d[ i ].remove( removed, options );
      
      return this;
    }, // emit_remove()
    
    /* ------------------------------------------------------------------------
       emit_update( updated [, options ] )
       
       Notify downsteam pipelets of updated object values.
       
       Parameters:
         - updated: Array of updates, each update is an Array of two objects:
           - the first is the previous object value,
           - the second is the updated object value.
         
         - options: optional object
    */
    emit_update: function( updated, options ) {
      var d = this.destinations, l = d.length;
      
      for ( var i = -1; ++i < l; ) d[ i ].update( updated, options );
      
      return this;
    }, // emit_update()
    
    /* ------------------------------------------------------------------------
       emit_clear( [ options ] )
       
       Notify downsteam pipelets that all object values should be cleared.
       
       Parameters:
         - options: optional object
    */
    emit_clear: function( options ) {
      var d = this.destinations, l = d.length;
      
      for ( var i = -1; ++i < l; ) d[ i ].clear( options );
      
      return this;
    }, // emit_clear()
    
    _add_destination: function( d ) {
      if ( this.destinations.indexOf( d ) !== -1 ) throw new Error( "Fork, _add_destination(), invalid destination: already there" );
      
      this.destinations.push( d );
      
      return this;
    }, // _add_destination()
    
    _remove_destination: function( p ) {
      var d = this.destinations;
      
      if ( ( p = d.indexOf( p ) ) === -1 ) throw new Error( "Fork, _remove_destination(), destination not found in this" );
      
      d.splice( p, 1 );
      
      return this;
    } // _remove_destination()
  } ); // Fork.prototype
  
  /* -------------------------------------------------------------------------------------------
     Union( sources, options )
     
     Forwards many sources to one destination
  */
  function Union( sources, options ) {
    Pipelet.call( this, options );
    
    this.sources = [];
    
    if ( sources ) {
      for( var i = -1; ++i < sources.length; ) {
        var p = sources[ i ];
        
        if ( p && p instanceof Pipelet ) this.add_source( p );
      }
    }
    
    return this;
  } // Union()
  
  Pipelet.build( 'union', Union, {
    /* ------------------------------------------------------------------------
       fetch( receiver )
    */
    fetch: function( receiver ) {
      var u, sources = this.sources;
      
      for ( var i = -1; ++i < sources.length; ) {
        var source = sources[ i ];
        
        if ( source.fetch ) {
          source.fetch( function( values ) {
            values && values.length && receiver( values );
          } )
        } else {
          receiver( source );
        }
      }
      
      receiver( u, true );
      
      return this;
    }, // fetch()
    
    _add_source: function( source ) {
      if ( this.sources.indexOf( source ) !== -1 ) throw new Error( "Union, _add_source(), invalid source: already there" );
      
      this.sources.push( source );
      
      return this;
    }, // _add_source()
    
    _remove_source: function( source ) {
      var s = this.sources;
      
      if ( ( source = s.indexOf( source ) ) === -1 ) throw new Error( "Union, _remove_source(), source not found in this" );
      
      s.splice( source, 1 );
      
      return this;
    } // _remove_source()
  } ); // Union.prototype
  
  /* -------------------------------------------------------------------------------------------
     Set( [values], [options] )
     
     Non-ordered set.
     
     Parameters:
       - values: an array of objects to set initial content.
       
       - options: optional object to provide options for Set and parent class Pipelet:
         - name: set name
         - key: unique key for each value, default is [ 'id' ]
         - auto_increment: (String or Boolean) the name of the field auto-incremented
                           if true, the field is set to 'id'
         - auto_increment_start: (Integer) if auto_increment, used to start the sequence,
                                 default is zero which will start at 1 because it is
                                 pre-incremented.
  */
  function Set( a, options ) {
    var u;
    
    if ( options === u ) {
      options = a;
      a = u;
    }
     
    options = Pipelet.call( this, options ).options;
    
    if ( this.auto_increment = options.auto_increment ) {
      if ( this.auto_increment === true ) this.auto_increment = 'id';
      
      this.auto_increment_value = this.options.auto_increment_start || 0;
    }
    
    this.a = []; // The current state of the set
    this.b = []; // Anti-state, used to store removes waiting for adds and conflict resolution
    
    a && this.add( a )
    
    de&&ug( "New Set, name: " + options.name + ", length: " + this.a.length );
    
    return this;
  } // Set()
  
  Pipelet.build( 'set', Set );
  
  /* -------------------------------------------------------------------------------------------
     Set instance methods
  */
  extend( Set.prototype, {
    /* ------------------------------------------------------------------------
       fetch( receiver )
       
       Fetches set content, possibly in several chunks.
       
       See Pipelet.fetch() for receiver documentation.
    */
    fetch: function( receiver ) {
      receiver( this.a, true );
      
      return this;
    }, // fetch()
    
    /* ------------------------------------------------------------------------
       clear()
       
       Clears content then notifes downsteam Pipelets.
    */
    clear: function() {
      this.a = [];
      
      return this.emit_clear();
    }, // get()
    
    /* ------------------------------------------------------------------------
       add( values )
       
       Add values to the set then notifies downsteam Pipelets.
       
       ToDo: should we test for double insertion? This could happen if two
         adds on the same key would be separated by a remove that would
         come later because the order of operations is not guarantied.
    */
    add: function( values, options ) {
      var auto_increment = this.auto_increment, i, l = values.length;
      
      if ( auto_increment ) {
        var auto_increment_value = this.auto_increment_value;
        
        for ( i = -1; ++i < l; ) {
          values[ i ][ auto_increment ] = ++auto_increment_value;
        }
        
        this.auto_increment_value = auto_increment_value;
      }
      
      if ( this.b.length ) {
        // There are values in the anti-state b, waiting for an add or
        // update, or conflict resolution
        var added = [], removed = [];
        
        for ( i = -1; ++i < l; ) {
          var v = values[ i ]
            , p = this._index_of( v )
          ;
          
          if ( p === -1 ) {
            this.a.push( v );
            
            added.push( v );
          } else {
            // Remove this add from the anti-state
            this.b.splice( p, 1 );
          }
        }
        
        values = added; 
      } else {
        push.apply( this.a, values );
      }
      
      return values.length ? this.emit_add( values, options ) : this;
    }, // add()
    
    /* ------------------------------------------------------------------------
       update( updates )
       
       Update set values using updates then notifes downsteam Pipelets.
       
       Parameter:
         updates: Array of updates, an update is an array of two values, the
           first is the previous value, the second is the updated value.
    */
    update: function( updates, options ) {
      for ( var i = -1, l = updates.length, updated = [], added = []; ++i < l; ) {
        var o = updates[ i ]
          , p = this.index_of( o[ 0 ] )
          , v = o[ 1 ]
        ;
        
        if ( p === -1 ) {
          // This update may come before an add
          p = this._index_of( v );
          
          if ( p === -1 ) {
            this.a.push( v );
            
            added.push( v );
          } else {
            // There is a remove in the anti-state waiting for this add
            this.b.slice( p, 1 );
          }
          
          this.b.push( o[ 0 ] );
          
          continue;
        }
        
        this.a[ p ] = v;
        
        updated.push( o );
      }
      
      if ( added.length ) { // ToDo: not tested
        if ( updated.length ) {
          this.emit_add( added, extend( {}, options, { more: true } ) );
        } else {
          this.emit_add   ( added, options );
        }
      }
      
      updated.length && this.emit_update( updated, options );
      
      return this;
    }, // update()
    
    /* ------------------------------------------------------------------------
       remove( values )
       
       Remove values from the set then notify downsteam Pipelets
    */
    remove: function( values, options ) {
      for ( var i = -1, l = values.length, removed = []; ++i < l; ) {
        var v = values[ i ]
          , p = this.index_of( v )
        ;
        
        if ( p === -1 ) {
          // Not found: add to anti-state
          this.b.push( v );
        } else {
          this.a.splice( p, 1 ); // could be faster on smaller arrays
          
          removed.push( v );
        }
      }
      
      return this.emit_remove( removed, options );
    }, // remove()
    
    /* ------------------------------------------------------------------------
       index_of( value )
       
       Lookup the position of a value in the set's current state.
       
       Generate optimized code using make_index_of() during first call.
       
       Returns:
         The position of the value in the set or -1 if not found.
    */
    index_of: function( v ) {
      return this.make_index_of( 'a', 'index_of' ).index_of( v ); 
    }, // index_of()
    
    /* ------------------------------------------------------------------------
       _index_of( value )
       
       Lookup the position of a vaue in the set's anti-state.
       
       Generate optimized code using make_index_of() during first call.
       
       Returns:
         The position of the value in the set or -1 if not found.
    */
    _index_of: function( v ) {
      return this.make_index_of( 'b', '_index_of' )._index_of( v ); 
    }, // _index_of()
    
    /* ------------------------------------------------------------------------
       make_index_of( state, method )
        
       JIT Code Generator for index_of() from this.key
       
       Generated code is tied to current key. Uses unrolled while for maximum
       performance.
       
       Parameters:
         - state: (string) 'a' or 'b' to reference the current state or anti-
                  state of the set.
         - method: (string) the name of the method to generate
       
       Other possible further optimization:
         - split set array in smaller arrays,
         - create an object for fast access to individual keys, a naive
           implementation would be to use a single object but many benchmarcks
           have proven this technique very slow. A better option would be to
           use a tree possibly with hashed keys
    */
    make_index_of: function( state, method ) {
      var key = this.key, l = key.length;
      
      var vars = [ 'a = this.' + state, 'l = a.length', 'i = -1' ];
      
      var first, inner, last;
      
      if ( l > 1 ) {
        vars.push( 'r' );
        
        var tests = [], field;
        
        for( var i = -1; ++i < l; ) {
          field = key[ i ];
          
          tests.push( ( i === 0 ? '( r = a[ ++i ] ).' : 'r.' ) + field + ' === _' + field );
        }
        
        first = 'if ( ' + tests.join( ' && ' ) + ' ) return i;';
      } else {
        field = key[ 0 ];
        
        var test = 'a[ ++i ].' + field + ' === _' + field;
        
        first = 'if ( ' + test;
        inner = '|| ' + test;
        last  = ') return i';
      }
      
      var code = new Code( method )
        ._function( 'this.' + method, null, [ 'o' ] )
          ._var( vars )
          .vars_from_object( 'o', key ) // Local variables for key
          .unrolled_while( first, inner, last )
          .add( 'return -1' )
        .end( method + '()' )
        .get()
      ;
      
      eval( code );
      
      return this;
    } // make_index_of()
  } ); // Set instance methods
  
  /* -------------------------------------------------------------------------------------------
     PXXX(): template for Pipelet class definition.
  */
  function PXXX( source, options ) {
    Pipelet.call( this, options );
    
    return this;
  } // PXXX()
  
  subclass( Pipelet, PXXX );
  
  /* ------------------------------------------------------------------------
     Template pipelet
  */
  Pipelet.prototype.pxxx = function( options ) {
    return new PXXX( options ).add_source( this );
  }; // Pipelet.prototype.pxxx()
  
  extend( PXXX.prototype, {
    /* ------------------------------------------------------------------------
       add( values )
       
       Called when items were added to the source
    */
    add: function( values ) {
      return this.emit_add( values ); // forward added values
    }, // add()
    
    /* ------------------------------------------------------------------------
       remove( values )
       
       Called when items were removed from the source
    */
    remove: function( values ) {
      return this.emit_remove( values ); // forward removed values
    }, // remove()
    
    /* ------------------------------------------------------------------------
       update( updates )
       
       Called when items were updated inside the source
    */
    update: function( updates ) {
      return this.emit_update( updates ); // forward updated values
    }, // update()
    
    /* ------------------------------------------------------------------------
       clear()
       
       Called when all items should be cleared, when the source set
        was disconnected from its source and new data is expected.
    */
    clear: function() {
      return this.emit_clear(); // forward to downstream pipelets
    } // clear()
  } ); // PXXX instance methods
  
  /* --------------------------------------------------------------------------
     module exports
  */
  eval( XS.export_code( 'XS', [ 'Compose', 'Pipelet', 'Fork', 'Union', 'Set', 'xs' ] ) );
  
  de&&ug( "module loaded" );
} )( this ); // pipelet.js
