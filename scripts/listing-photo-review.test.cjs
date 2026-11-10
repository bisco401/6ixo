const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewGallery } = require('./apply-listing-photo-quality.cjs');
const integrity = require('./lib/listing-integrity.cjs');

test('retain sharp gallery photos and remove native thumbnails', () => {
    const dimensions = new Map([['tiny', {width:225,height:225}], ['clear', {width:1600,height:1200}]]);
    assert.deepEqual(reviewGallery({ image_urls:'tiny|clear' }, dimensions),
        {kept:['clear'],removed:['tiny'],unknown:[],hold:false});
    assert.equal(reviewGallery({image_urls:'tiny'}, dimensions).hold, true);
});
test('enlarged Kenya thumbnails are judged by their original pixels', () => {
    const local = 'data/pigiame-clean-images/own.jpg';
    const row = {image_urls:local,attributes:JSON.stringify({originalImageUrls:['https://i.roamcdn.net/hz/pi/listing-thumb-224w/own.jpg']})};
    assert.equal(reviewGallery(row,new Map([[local,{width:640,height:480}]])).hold,true);
});
test('temporary source failures do not remove listings', () => {
    const result = reviewGallery({image_urls:'offline'},new Map([['offline',{error:'timeout'}]]));
    assert.equal(result.hold,false);
    assert.deepEqual(result.kept,['offline']);
    assert.deepEqual(result.unknown,['offline']);
});
test('repeated missing-image responses are excluded without treating timeouts as proof', () => {
    const result = reviewGallery({image_urls:'missing|timeout'},new Map([
        ['missing',{error:'HTTP Error 404: Not Found',attempts:2}],['timeout',{error:'timed out',attempts:2}]
    ]));
    assert.deepEqual(result.removed,['missing']);
    assert.deepEqual(result.kept,['timeout']);
    assert.equal(result.hold,false);
});
test('photo exclusions survive a newer import without weakening source identity', () => {
    const url='https://example.com/listing/own';
    const row={source_url:url,title:'Own listing',status:'published',phone:'4165550123',image_urls:'https://example.com/tiny.jpg|https://example.com/clear.jpg',
        attributes:JSON.stringify({imageVerifiedAt:'2027-01-01',listingIdentity:{sourceUrl:url,title:'Own listing',images:['https://example.com/tiny.jpg','https://example.com/clear.jpg']}})};
    const repair={sourceUrl:url,title:row.title,excludedImages:['https://example.com/tiny.jpg']};
    const result=integrity.applyRepair(row,repair);
    assert.equal(result.image_urls,'https://example.com/clear.jpg');
    assert.equal(integrity.publicationIssue(result),'');
    const held=integrity.applyRepair(row,{...repair,holdReason:'low_resolution_photos'});
    assert.equal(held.status,'rejected');
    assert.equal(integrity.applyRepair({...row,source_url:'https://example.com/listing/other'},repair).image_urls,row.image_urls);
});
