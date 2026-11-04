$preview=true;
module heavy(){ difference(){ union(){ for(i=[0:40]) translate([i*2,0,0]) sphere(r=6,$fn=48); } for(i=[0:40]) translate([i*2+1,0,0]) rotate([90,0,0]) cylinder(r=2,h=30,center=true,$fn=48); } }
heavy();
translate([0,0,20]) rotate([0,0,$t*360]) cube([10,4,4]);
